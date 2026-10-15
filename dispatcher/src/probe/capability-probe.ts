// SPDX-License-Identifier: Apache-2.0

// The capability probe of a Dispatcher instance (#331): it runs the Worker image's `probe` mode somewhere that
// has the real hardening (a canary VM, see launchers/sandbox-canary.ts) and remembers the answer, so that
// `opencode` is advertised only from a fresh proof. Fail closed, in every direction:
//
//   - no probe yet, or the answer is older than its time to live: nothing is proven (`fresh()` is undefined)
//   - the container says no, or says something that is not a verdict, or the probe cannot run, or it takes too
//     long: PR-Agent only, with a stable reason or code, never the text of anything
//   - one probe at a time per instance: any number of callers share the one that is running
//
// A pass lives for `ttlMs` (1 hour); a probe that could not give an answer is asked again after `failureTtlMs`
// (a minute), so a platform that comes back is used again soon, and an outage does not create a VM per wake-up.
// Platform-free: the run itself is a function the caller brings.
import type { Clock, Engine, Logger } from "../core/types.ts";
import { parseProbeOutput, type ProbeReason } from "./verdict.ts";

export const DEFAULT_PROBE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_PROBE_FAILURE_TTL_MS = 60 * 1000;
export const DEFAULT_PROBE_TIMEOUT_MS = 150 * 1000;

const STABLE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** A probe that could not be run. The code is stable; the message is not read by anyone. */
export class ProbeRunError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ProbeRunError";
    this.code = code;
  }
}

/**
 * Runs the probe once and returns the stdout of the container's `probe` mode. Rejects (ideally with a
 * `ProbeRunError` or a `LaunchError`, anything with a stable `code`) when it could not run. It must stop and clean
 * up what it started when `signal` aborts (the timeout).
 */
export type ProbeRunner = (signal: AbortSignal) => Promise<string>;

export type ProbeStatus = "passed" | "denied" | "failed";

/** What the probe found. Holds engines, stable reasons and a stable code and nothing else. */
export type ProbeOutcome = {
  status: ProbeStatus;
  /** What this instance may advertise: `opencode` only for `passed`. */
  engines: Engine[];
  /** Why the container left `opencode` out (`denied`). */
  reasons: ProbeReason[];
  /** Why no verdict was read (`failed`): a launch error code, `probe_timeout`, `probe_unreadable`, `probe_error`. */
  failure?: string;
  /** Milliseconds on the probe's clock when the answer was read. */
  checkedAt: number;
  /** Milliseconds on the probe's clock until which the answer counts. */
  expiresAt: number;
};

export type CapabilityProbeOptions = {
  run: ProbeRunner;
  clock: Clock;
  /** Milliseconds, on the same time line as the clock; a test moves both by hand. */
  now: () => number;
  logger: Logger;
  ttlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
};

export interface CapabilityProbe {
  /** The answer that still counts, or undefined (never probed, or older than its time to live). Runs nothing. */
  fresh(): ProbeOutcome | undefined;
  /**
   * Makes sure a probe is on its way when no answer counts: undefined when one does, otherwise the running probe
   * (started now unless one runs already). Never rejects. The caller hands the promise to the platform
   * (`waitUntil`) so that the work is not cut off.
   */
  ensure(): Promise<ProbeOutcome> | undefined;
  /** Runs a probe now, or joins the one that runs, whatever the age of the last answer. Never rejects. */
  refresh(): Promise<ProbeOutcome>;
}

function stableCode(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    STABLE_CODE.test(error.code)
  )
    return error.code;
  return fallback;
}

export function createCapabilityProbe(
  options: CapabilityProbeOptions,
): CapabilityProbe {
  const { run, clock, now, logger } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_PROBE_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_PROBE_FAILURE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let current: ProbeOutcome | undefined;
  let running: Promise<ProbeOutcome> | undefined;

  function fresh(): ProbeOutcome | undefined {
    return current !== undefined && now() < current.expiresAt
      ? current
      : undefined;
  }

  function failed(code: string): ProbeOutcome {
    const at = now();
    logger.warn("probe_failed", { code });
    return {
      status: "failed",
      engines: ["pr-agent"],
      reasons: [],
      failure: code,
      checkedAt: at,
      expiresAt: at + failureTtlMs,
    };
  }

  async function execute(): Promise<ProbeOutcome> {
    const stop = new AbortController();
    const finished = new AbortController();
    const timer = clock
      .sleep(timeoutMs, finished.signal)
      .then(() => (finished.signal.aborted ? undefined : ("timeout" as const)));
    try {
      const attempt = run(stop.signal);
      // A run that ends after its timeout must not be an unhandled rejection.
      attempt.catch(() => undefined);
      const result = await Promise.race([
        attempt.then((stdout) => ({ stdout })),
        timer,
      ]);
      if (result === "timeout" || result === undefined) {
        stop.abort();
        return failed("probe_timeout");
      }
      const verdict = parseProbeOutput(result.stdout);
      if (verdict === undefined) return failed("probe_unreadable");
      const at = now();
      if (verdict.passed) {
        logger.info("probe_passed", { engines: verdict.engines });
        return {
          status: "passed",
          engines: verdict.engines,
          reasons: [],
          checkedAt: at,
          expiresAt: at + ttlMs,
        };
      }
      logger.warn("probe_denied", { reasons: verdict.reasons });
      return {
        status: "denied",
        engines: verdict.engines.filter((engine) => engine !== "opencode"),
        reasons: verdict.reasons,
        checkedAt: at,
        expiresAt: at + ttlMs,
      };
    } catch (error) {
      stop.abort();
      return failed(stableCode(error, "probe_error"));
    } finally {
      finished.abort();
    }
  }

  function refresh(): Promise<ProbeOutcome> {
    if (running !== undefined) return running;
    const started = execute()
      .then((outcome) => {
        current = outcome;
        return outcome;
      })
      .finally(() => {
        running = undefined;
      });
    running = started;
    return started;
  }

  return {
    fresh,
    ensure() {
      if (fresh() !== undefined) return undefined;
      return refresh();
    },
    refresh,
  };
}
