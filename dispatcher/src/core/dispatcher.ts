// SPDX-License-Identifier: Apache-2.0

// The Dispatcher core: the platform-free part between a Trigger (which learns that a job exists) and a
// Launcher (which starts its Worker). It claims, holds the per-job credential only while it hands the job
// over, keeps the lease alive during the launch and gives the job back when the launch fails.
//
//   handle(hint) -> capability check -> capacity -> App version -> claim -> { started, background }
//   background:  launch(spec) while heartbeating with the job credential
//                deadline, lost lease or abort -> stop the launch; launch failed -> release(launch_failed)
//
// It never sees the job input, the git token or the model key: the App hands those to the Worker.
import {
  createAppClient,
  type AppClient,
  type AppFailure,
  type ClaimedJob,
} from "./app-client.ts";
import { systemClock } from "./clock.ts";
import {
  ENGINE_BY_KIND,
  type Clock,
  type CoreSettings,
  type DispatcherCore,
  type Engine,
  type HandleResult,
  type JobHint,
  type Launcher,
  LaunchError,
  type Logger,
} from "./types.ts";

const DEFAULT_RETRY_BUSY_SECONDS = 30;
const DEFAULT_RETRY_UNAVAILABLE_SECONDS = 60;
const DEFAULT_RETRY_REJECTED_SECONDS = 300;
const RETRY_CEILING_SECONDS = 3600;
/** How long the App is asked not to offer a released job again (a platform outage should not burn all attempts at once). */
const RELEASE_RETRY_AFTER_SECONDS = 30;
const RELEASE_ATTEMPTS = 3;
/** The App's answer to the version question is remembered this long. */
const VERSION_TTL_MS = 10 * 60 * 1000;
const MIN_HEARTBEAT_SECONDS = 5;

export type CoreDependencies = {
  settings: CoreSettings;
  launcher: Launcher;
  logger: Logger;
  clock?: Clock;
  fetch?: typeof fetch;
  /** Milliseconds, for the memory of the version answer. */
  now?: () => number;
  requestTimeoutMs?: number;
};

type Abort = { signal: AbortSignal; why: () => string | undefined };

function clampRetry(seconds: number | undefined, fallback: number): number {
  if (seconds === undefined || seconds < 1) return fallback;
  return Math.min(seconds, RETRY_CEILING_SECONDS);
}

export function createDispatcherCore(deps: CoreDependencies): DispatcherCore {
  const { settings, launcher, logger } = deps;
  const clock = deps.clock ?? systemClock;
  const now = deps.now ?? (() => Date.now());
  const app: AppClient = createAppClient({
    appUrl: settings.appUrl,
    token: settings.token,
    poolId: settings.poolId,
    fetch: deps.fetch ?? fetch,
    requestTimeoutMs: deps.requestTimeoutMs,
  });
  const shutdown = new AbortController();
  /** Launches in progress (claimed or being claimed): the local share of the cap. */
  let launching = 0;
  let versionOkUntil = 0;

  async function engines(
    hint: JobHint,
  ): Promise<Engine[] | "not_capable" | "unavailable"> {
    let offered: readonly Engine[];
    try {
      offered = await launcher.capabilities(shutdown.signal);
    } catch {
      logger.error("capabilities_failed");
      return "unavailable";
    }
    const usable = settings.engines.filter((engine) =>
      offered.includes(engine),
    );
    if (usable.length === 0) return "not_capable";
    if (
      hint.reviewKind !== undefined &&
      !usable.includes(ENGINE_BY_KIND[hint.reviewKind])
    )
      return "not_capable";
    return usable;
  }

  async function appSupportsTheSplit(): Promise<
    { ok: true } | { ok: false; code: AppFailure; retryAfterSeconds?: number }
  > {
    if (now() < versionOkUntil) return { ok: true };
    const checked = await app.checkVersion();
    if (checked.ok) versionOkUntil = now() + VERSION_TTL_MS;
    return checked;
  }

  async function handle(hint: JobHint): Promise<HandleResult> {
    const usable = await engines(hint);
    if (usable === "unavailable")
      return {
        outcome: "unavailable",
        retryAfterSeconds: DEFAULT_RETRY_UNAVAILABLE_SECONDS,
      };
    if (usable === "not_capable") {
      logger.info("not_capable", { reviewKind: hint.reviewKind });
      return { outcome: "not_capable" };
    }
    if (launching >= settings.maxRunning) {
      logger.info("busy", { launching });
      return { outcome: "busy", retryAfterSeconds: DEFAULT_RETRY_BUSY_SECONDS };
    }

    // The slot is taken before the first await, so two wake-up calls cannot both pass the check.
    launching += 1;
    let handedOver = false;
    try {
      const supported = await appSupportsTheSplit();
      if (!supported.ok) {
        logger.error("app_unsupported", { code: supported.code });
        return {
          outcome: "unavailable",
          retryAfterSeconds: clampRetry(
            supported.retryAfterSeconds,
            DEFAULT_RETRY_UNAVAILABLE_SECONDS,
          ),
        };
      }
      const claimed = await app.claim({
        engines: usable,
        ...(hint.jobId === undefined ? {} : { jobId: hint.jobId }),
        maxRunning: settings.maxRunning,
      });
      if (claimed.kind === "none") {
        logger.info("claim_none", { jobId: hint.jobId });
        return { outcome: "ignored" };
      }
      if (claimed.kind === "busy") {
        logger.warn("claim_busy", { jobId: hint.jobId });
        return {
          outcome: "busy",
          retryAfterSeconds: clampRetry(
            claimed.retryAfterSeconds,
            DEFAULT_RETRY_BUSY_SECONDS,
          ),
        };
      }
      if (claimed.kind === "unavailable") {
        logger.error("claim_failed", { jobId: hint.jobId, code: claimed.code });
        const fallback =
          claimed.code === "app_rejected"
            ? DEFAULT_RETRY_REJECTED_SECONDS
            : DEFAULT_RETRY_UNAVAILABLE_SECONDS;
        return {
          outcome: "unavailable",
          retryAfterSeconds: clampRetry(claimed.retryAfterSeconds, fallback),
        };
      }
      // The slot is given back when the launch phase ends, by the background work.
      handedOver = true;
      return { outcome: "started", background: runLaunch(claimed.job) };
    } finally {
      if (!handedOver) launching -= 1;
    }
  }

  /** The launch phase of one claimed job. Never rejects. The credential lives in this scope only. */
  async function runLaunch(job: ClaimedJob): Promise<void> {
    const startedAt = now();
    // Aborts the Launcher: the deadline, a lost lease or a shutdown. Never aborted after a successful launch,
    // because a Launcher may tie the Worker's life to its signal.
    const stop = new AbortController();
    let reason: "deadline" | "lease_lost" | "shutdown" | undefined;
    const stopFor = (why: NonNullable<typeof reason>) => {
      if (reason !== undefined) return;
      reason = why;
      stop.abort();
    };
    const onShutdown = () => stopFor("shutdown");
    shutdown.signal.addEventListener("abort", onShutdown, { once: true });
    if (shutdown.signal.aborted) onShutdown();
    // Ends the timers of this phase, whatever way it ends.
    const phaseDone = new AbortController();
    const timers = AbortSignal.any([phaseDone.signal, stop.signal]);

    const guard: Abort = { signal: stop.signal, why: () => reason };
    const heartbeatMs =
      Math.max(MIN_HEARTBEAT_SECONDS, job.heartbeatIntervalSeconds) * 1000;
    void (async () => {
      for (;;) {
        await clock.sleep(heartbeatMs, timers);
        if (timers.aborted) return;
        const beat = await app.heartbeat(job.id, job.credential);
        if (beat === "lease_lost") {
          logger.warn("lease_lost", { jobId: job.id });
          stopFor("lease_lost");
          return;
        }
        if (beat === "failed")
          logger.warn("heartbeat_failed", { jobId: job.id });
      }
    })();
    void clock
      .sleep(settings.launchDeadlineSeconds * 1000, phaseDone.signal)
      .then(() => {
        if (!phaseDone.signal.aborted) stopFor("deadline");
      });

    try {
      await launchWith(job, guard);
      logger.info("launched", {
        jobId: job.id,
        kind: job.reviewKind,
        ms: now() - startedAt,
      });
    } catch (error) {
      const code = errorCode(error);
      logger.error("launch_failed", {
        jobId: job.id,
        kind: job.reviewKind,
        code,
        ...(error instanceof LaunchError ? { retryable: error.retryable } : {}),
        stopped: reason,
      });
      // A lost lease means the App already gave the job away: there is nothing of ours to release.
      if (reason !== "lease_lost") await release(job);
    } finally {
      phaseDone.abort();
      shutdown.signal.removeEventListener("abort", onShutdown);
      launching -= 1;
    }
  }

  async function launchWith(job: ClaimedJob, guard: Abort): Promise<void> {
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new AbortedError(guard.why() ?? "aborted"));
      if (guard.signal.aborted) fail();
      else guard.signal.addEventListener("abort", fail, { once: true });
    });
    // A Launcher that ignores the signal cannot hold the deadline hostage.
    const launched = launcher.launch(
      {
        appUrl: settings.appUrl,
        jobId: job.id,
        credential: job.credential,
        kind: job.reviewKind,
        timeoutSeconds: settings.jobTimeoutSeconds,
        config: settings.workerConfig[job.reviewKind],
      },
      guard.signal,
    );
    launched.catch(() => undefined);
    await Promise.race([launched, aborted]);
  }

  async function release(job: ClaimedJob): Promise<void> {
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt += 1) {
      const result = await app.release(
        job.id,
        job.credential,
        RELEASE_RETRY_AFTER_SECONDS,
      );
      if (result === "released") {
        logger.info("released", { jobId: job.id, reason: "launch_failed" });
        return;
      }
      if (result === "not_holder") {
        logger.warn("release_not_holder", { jobId: job.id });
        return;
      }
      if (attempt < RELEASE_ATTEMPTS) await clock.sleep(attempt * 1000);
    }
    // The lease runs out and the App gives the job back by itself; the cost is the wait.
    logger.error("release_failed", { jobId: job.id });
  }

  return {
    handle,
    abort() {
      shutdown.abort();
    },
  };
}

class AbortedError extends Error {
  readonly code: string;

  constructor(why: string) {
    super(why);
    this.name = "AbortedError";
    this.code = `launch_${why}`;
  }
}

/** The stable code of a launch error. Only a code is logged: the text of an error is not ours to trust. */
function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
  )
    return error.code;
  return "launch_error";
}
