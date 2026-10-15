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
import { probeFailureCode, type ProbeFailureCode } from "./failure-codes.ts";
import { parseProbeOutput, type ProbeReason } from "./verdict.ts";

export const DEFAULT_PROBE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_PROBE_FAILURE_TTL_MS = 60 * 1000;
export const DEFAULT_PROBE_TIMEOUT_MS = 150 * 1000;
/** A forced probe (`POST /probe`) is served from an answer younger than this instead of starting another VM. */
export const DEFAULT_PROBE_FORCE_REUSE_MS = 60 * 1000;
/** After a timeout, how long to wait for the run to finish stopping what it started (the canary's VM). */
export const DEFAULT_PROBE_ABORT_GRACE_MS = 10 * 1000;

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
  /** Why no verdict was read (`failed`): a code of the closed list (`failure-codes.ts`). */
  failure?: ProbeFailureCode;
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
  /** A forced probe is served from an answer younger than this (0: never). */
  forceReuseMs?: number;
  /** How long a timed out run may take to finish stopping what it started before the probe answers anyway. */
  abortGraceMs?: number;
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
  /**
   * A forced probe (`POST /probe`): joins the one that runs, else serves the last answer (any status) when it is
   * younger than the reuse time, else runs one. A forced probe that only failed (the platform, a timeout) never
   * replaces a pass that still counts, though the caller is told of the failure; a real denial does replace it.
   */
  force(): Promise<ProbeOutcome>;
}

export function createCapabilityProbe(
  options: CapabilityProbeOptions,
): CapabilityProbe {
  const { run, clock, now, logger } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_PROBE_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_PROBE_FAILURE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const forceReuseMs = options.forceReuseMs ?? DEFAULT_PROBE_FORCE_REUSE_MS;
  const abortGraceMs = options.abortGraceMs ?? DEFAULT_PROBE_ABORT_GRACE_MS;
  /** The answer that counts for the Launcher (never replaced by a bare failure while it is valid). */
  let current: ProbeOutcome | undefined;
  /** The latest answer of any status: what a forced probe may reuse. */
  let last: ProbeOutcome | undefined;
  let running: Promise<ProbeOutcome> | undefined;

  function fresh(): ProbeOutcome | undefined {
    return current !== undefined && now() < current.expiresAt
      ? current
      : undefined;
  }

  function failed(value: unknown): ProbeOutcome {
    const code = probeFailureCode(value);
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
    let attempt: Promise<string> | undefined;
    try {
      attempt = run(stop.signal);
      // A run that ends after its timeout must not be an unhandled rejection.
      attempt.catch(() => undefined);
      const result = await Promise.race([
        attempt.then((stdout) => ({ stdout })),
        timer,
      ]);
      if (result === "timeout" || result === undefined) {
        stop.abort();
        // The VM is stopped by the run's own cleanup, which must be finished before the work that holds the
        // function alive ends (`waitUntil`): wait for it, but not for ever.
        const grace = new AbortController();
        await Promise.race([
          attempt.then(
            () => undefined,
            () => undefined,
          ),
          clock.sleep(abortGraceMs, grace.signal),
        ]);
        grace.abort();
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
      return failed(
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined,
      );
    } finally {
      finished.abort();
    }
  }

  function refresh(): Promise<ProbeOutcome> {
    if (running !== undefined) return running;
    const started = execute()
      .then((outcome) => {
        last = outcome;
        // A probe that only failed does not take away a pass that still counts: the platform had a bad minute,
        // the container did not change its answer. A denial is the container's answer and does replace it.
        if (outcome.status !== "failed" || fresh()?.status !== "passed")
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
    force() {
      if (running !== undefined) return running;
      if (
        last !== undefined &&
        forceReuseMs > 0 &&
        now() - last.checkedAt < forceReuseMs
      )
        return Promise.resolve(last);
      return refresh();
    },
  };
}
