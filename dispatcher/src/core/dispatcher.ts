// SPDX-License-Identifier: LicenseRef-Proprietary

// The Dispatcher core: the platform-free part between a Trigger (which learns that a job exists) and a
// Launcher (which starts its Worker). It claims, holds the per-job credential only while it hands the job
// over, keeps the lease alive during the launch and gives the job back when the launch fails.
//
//   handle(hint) -> capability check -> app's kinds -> capacity -> App version -> claim -> kind check -> { started, background }
//   background:  launch(spec) while heartbeating with the job credential
//                deadline, lost lease or abort -> stop the launch; launch failed -> release(launch_failed)
//   after that:  nothing. The Worker owns the lease and the core never looks at the job again (#487); the App tells the
//                Dispatcher when the claim ends (`POST /stop`)
//
// It never sees the job input, the git token or the model key: the App hands those to the Worker.
//
// Several apps (#730): every call names the app (`hint.appId`, the app whose signing key verified the wake-up call). The
// core keeps one client, one slot counter and one version memory per app, claims at that app only (a 204 is `ignored`:
// there is no looking at another app), refuses a kind the app is not allowed before and after the claim, and hands the
// Launcher the registry's URL of the app that claimed, never anything a request said.
import {
  createAppClient,
  type AppClient,
  type AppFailure,
  type ClaimedJob,
  type ReleaseReason,
  VM_LIFECYCLE_FEATURE,
} from "./app-client.ts";
import { systemClock } from "./clock.ts";
import {
  ENGINE_BY_KIND,
  type AppSettings,
  type Clock,
  type CoreSettings,
  type CreatedVm,
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
/** #493: the pauses before the repeats of a report of the VM that the App could not take (three tries). */
const VM_REPORT_RETRY_MS: readonly number[] = [1000, 3000];

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

type EnginesAnswer =
  | { kind: "usable"; engines: Engine[] }
  | { kind: "not_capable" }
  | { kind: "retry"; retryAfterSeconds: number };

type Abort = { signal: AbortSignal; why: () => string | undefined };

function clampRetry(seconds: number | undefined, fallback: number): number {
  if (seconds === undefined || seconds < 1) return fallback;
  return Math.min(seconds, RETRY_CEILING_SECONDS);
}

/** Everything the core keeps for one app (#730): nothing of it is shared with another app. */
type AppState = {
  settings: AppSettings;
  client: AppClient;
  /** Launches in progress (claimed or being claimed): the local share of this app's cap. */
  launching: number;
  versionOkUntil: number;
  /** #493: whether the App, as of the last version answer, takes the report of a VM. */
  takesVmReports: boolean;
};

export function createDispatcherCore(deps: CoreDependencies): DispatcherCore {
  const { settings, launcher, logger } = deps;
  const clock = deps.clock ?? systemClock;
  const now = deps.now ?? (() => Date.now());
  const apps = new Map<string, AppState>();
  for (const configured of settings.apps)
    apps.set(configured.id, {
      settings: configured,
      client: createAppClient({
        appUrl: configured.url,
        token: configured.token,
        poolId: configured.poolId,
        fetch: deps.fetch ?? fetch,
        requestTimeoutMs: deps.requestTimeoutMs,
      }),
      launching: 0,
      versionOkUntil: 0,
      takesVmReports: false,
    });
  const shutdown = new AbortController();

  /** The engines of the kinds an app may be given: what its claim asks for. */
  function allowedEngines(state: AppState): Engine[] {
    return [
      ...new Set(state.settings.kinds.map((kind) => ENGINE_BY_KIND[kind])),
    ];
  }

  async function engines(hint: JobHint): Promise<EnginesAnswer> {
    let offered: readonly Engine[];
    try {
      offered = await launcher.capabilities(shutdown.signal);
    } catch {
      logger.error("capabilities_failed");
      return {
        kind: "retry",
        retryAfterSeconds: DEFAULT_RETRY_UNAVAILABLE_SECONDS,
      };
    }
    const usable = settings.engines.filter((engine) =>
      offered.includes(engine),
    );
    if (usable.length === 0) return { kind: "not_capable" };
    if (
      hint.reviewKind !== undefined &&
      !usable.includes(ENGINE_BY_KIND[hint.reviewKind])
    )
      return { kind: "not_capable" };
    return { kind: "usable", engines: usable };
  }

  async function appSupportsTheSplit(
    state: AppState,
  ): Promise<
    { ok: true } | { ok: false; code: AppFailure; retryAfterSeconds?: number }
  > {
    if (now() < state.versionOkUntil) return { ok: true };
    const checked = await state.client.checkVersion();
    if (!checked.ok) return checked;
    state.versionOkUntil = now() + VERSION_TTL_MS;
    state.takesVmReports = checked.features.includes(VM_LIFECYCLE_FEATURE);
    return { ok: true };
  }

  async function handle(hint: JobHint): Promise<HandleResult> {
    const state = apps.get(hint.appId);
    if (state === undefined) {
      // Cannot happen for a call a verified key led to; fail closed all the same.
      logger.error("app_unknown");
      return { outcome: "not_capable" };
    }
    const app = state.client;
    const appId = state.settings.id;
    const answer = await engines(hint);
    if (answer.kind === "retry")
      return {
        outcome: "unavailable",
        retryAfterSeconds: answer.retryAfterSeconds,
      };
    if (answer.kind === "not_capable") {
      logger.info("not_capable", { app: appId, reviewKind: hint.reviewKind });
      return { outcome: "not_capable" };
    }
    // The first wall of the job kinds (#730): a kind the app may not submit is never claimed.
    if (
      hint.reviewKind !== undefined &&
      !state.settings.kinds.includes(hint.reviewKind)
    ) {
      logger.warn("kind_not_allowed", {
        app: appId,
        reviewKind: hint.reviewKind,
        stage: "dispatch",
      });
      return { outcome: "not_capable" };
    }
    // The claim asks for the engines of the app's kinds only, so an app is never handed a job it may not have.
    const allowed = allowedEngines(state);
    const claimEngines = answer.engines.filter((engine) =>
      allowed.includes(engine),
    );
    if (claimEngines.length === 0) {
      logger.info("not_capable", { app: appId, reviewKind: hint.reviewKind });
      return { outcome: "not_capable" };
    }
    if (state.launching >= state.settings.maxRunning) {
      logger.info("busy", { app: appId, launching: state.launching });
      return { outcome: "busy", retryAfterSeconds: DEFAULT_RETRY_BUSY_SECONDS };
    }

    // The slot is taken before the first await, so two wake-up calls cannot both pass the check.
    state.launching += 1;
    let handedOver = false;
    try {
      const supported = await appSupportsTheSplit(state);
      if (!supported.ok) {
        logger.error("app_unsupported", { app: appId, code: supported.code });
        return {
          outcome: "unavailable",
          retryAfterSeconds: clampRetry(
            supported.retryAfterSeconds,
            DEFAULT_RETRY_UNAVAILABLE_SECONDS,
          ),
        };
      }
      const claimed = await app.claim({
        engines: claimEngines,
        ...(hint.jobId === undefined ? {} : { jobId: hint.jobId }),
        maxRunning: state.settings.maxRunning,
      });
      if (claimed.kind === "none") {
        logger.info("claim_none", { app: appId, jobId: hint.jobId });
        return { outcome: "ignored" };
      }
      if (claimed.kind === "busy") {
        logger.warn("claim_busy", { app: appId, jobId: hint.jobId });
        return {
          outcome: "busy",
          retryAfterSeconds: clampRetry(
            claimed.retryAfterSeconds,
            DEFAULT_RETRY_BUSY_SECONDS,
          ),
        };
      }
      if (claimed.kind === "unavailable") {
        logger.error("claim_failed", {
          app: appId,
          jobId: hint.jobId,
          code: claimed.code,
        });
        const fallback =
          claimed.code === "app_rejected"
            ? DEFAULT_RETRY_REJECTED_SECONDS
            : DEFAULT_RETRY_UNAVAILABLE_SECONDS;
        return {
          outcome: "unavailable",
          retryAfterSeconds: clampRetry(claimed.retryAfterSeconds, fallback),
        };
      }
      // The second wall (#730): a job of a kind the app may not have (a misconfigured or compromised app) is given back
      // unlaunched, so no VM is created for it.
      if (!state.settings.kinds.includes(claimed.job.reviewKind)) {
        logger.error("kind_not_allowed", {
          app: appId,
          jobId: claimed.job.id,
          reviewKind: claimed.job.reviewKind,
          stage: "claim",
        });
        await release(state, claimed.job, "launch_failed");
        return { outcome: "not_capable" };
      }
      // The slot is given back when the launch phase ends, by the background work.
      handedOver = true;
      return { outcome: "started", background: runLaunch(state, claimed.job) };
    } finally {
      if (!handedOver) state.launching -= 1;
    }
  }

  /** The launch phase of one claimed job. Never rejects. The credential lives in this scope only. */
  async function runLaunch(state: AppState, job: ClaimedJob): Promise<void> {
    const app = state.client;
    const appId = state.settings.id;
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
          logger.warn("lease_lost", { app: appId, jobId: job.id });
          stopFor("lease_lost");
          return;
        }
        if (beat === "failed")
          logger.warn("heartbeat_failed", { app: appId, jobId: job.id });
      }
    })();
    void clock
      .sleep(settings.launchDeadlineSeconds * 1000, phaseDone.signal)
      .then(() => {
        if (!phaseDone.signal.aborted) stopFor("deadline");
      });

    // #493: the reports of the VM the Launcher created, in the background; awaited at the very end only.
    const reports: Promise<void>[] = [];
    const onVmCreated = (vm: CreatedVm) => {
      if (!state.takesVmReports) return;
      reports.push(reportVm(state, job, vm));
    };

    try {
      await launchWith(state, job, guard, onVmCreated);
      logger.info("launched", {
        app: appId,
        jobId: job.id,
        kind: job.reviewKind,
        ms: now() - startedAt,
      });
    } catch (error) {
      const code = errorCode(error);
      logger.error("launch_failed", {
        app: appId,
        jobId: job.id,
        kind: job.reviewKind,
        code,
        ...(error instanceof LaunchError ? { retryable: error.retryable } : {}),
        stopped: reason,
      });
      // A lost lease means the App already gave the job away: there is nothing of ours to release.
      if (reason !== "lease_lost") await release(state, job, "launch_failed");
    } finally {
      phaseDone.abort();
      shutdown.signal.removeEventListener("abort", onShutdown);
      state.launching -= 1;
      // The platform keeps the function alive for the work of the launch: do not end it before the reports are made.
      await Promise.allSettled(reports);
    }
  }

  /**
   * #493: tells the App that the VM exists. Best effort: a bounded repeat for what may pass (no answer, a busy or failing
   * App), none for a refusal, one log line with a stable code when it did not work, and nothing here ever throws or
   * touches the job.
   */
  async function reportVm(
    state: AppState,
    job: ClaimedJob,
    vm: CreatedVm,
  ): Promise<void> {
    try {
      for (let attempt = 0; ; attempt += 1) {
        const result = await state.client.reportVm(job.id, job.credential, vm);
        if (result === "recorded") return;
        const pause = VM_REPORT_RETRY_MS[attempt];
        if (result === "refused" || pause === undefined) break;
        await clock.sleep(pause);
      }
    } catch {
      // Only that it failed.
    }
    logger.warn("vm_report_failed", { app: state.settings.id, jobId: job.id });
  }

  async function launchWith(
    state: AppState,
    job: ClaimedJob,
    guard: Abort,
    onVmCreated: (vm: CreatedVm) => void,
  ): Promise<void> {
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new AbortedError(guard.why() ?? "aborted"));
      if (guard.signal.aborted) fail();
      else guard.signal.addEventListener("abort", fail, { once: true });
    });
    // A Launcher that ignores the signal cannot hold the deadline hostage.
    const launched = launcher.launch(
      {
        appId: state.settings.id,
        // The registry's URL of the app that claimed the job: never anything a request said.
        appUrl: state.settings.url,
        jobId: job.id,
        credential: job.credential,
        kind: job.reviewKind,
        timeoutSeconds: settings.jobTimeoutSeconds,
        config: settings.workerConfig[job.reviewKind],
        onVmCreated,
      },
      guard.signal,
    );
    launched.catch(() => undefined);
    await Promise.race([launched, aborted]);
  }

  async function release(
    state: AppState,
    job: ClaimedJob,
    reason: ReleaseReason,
  ): Promise<void> {
    const appId = state.settings.id;
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt += 1) {
      const result = await state.client.release(
        job.id,
        job.credential,
        reason,
        RELEASE_RETRY_AFTER_SECONDS,
      );
      if (result === "released") {
        logger.info("released", { app: appId, jobId: job.id, reason });
        return;
      }
      if (result === "ended") {
        // Not a problem: the Worker delivered its result (and may have exited 1 after a failed one). Nothing to give back.
        logger.info("release_job_ended", {
          app: appId,
          jobId: job.id,
          reason,
        });
        return;
      }
      if (result === "not_holder") {
        logger.warn("release_not_holder", {
          app: appId,
          jobId: job.id,
          reason,
        });
        return;
      }
      if (attempt < RELEASE_ATTEMPTS) await clock.sleep(attempt * 1000);
    }
    // The lease runs out and the App gives the job back by itself; the cost is the wait.
    logger.error("release_failed", { app: appId, jobId: job.id, reason });
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
