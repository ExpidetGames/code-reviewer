// SPDX-License-Identifier: LicenseRef-Proprietary

// The vocabulary of the Dispatcher core: what a Trigger hands in, what a Launcher must offer and what the
// core answers. Platform-free: no Node module, no platform SDK (checked by platform-free.test.ts).
import type {
  ReviewKind as ContractReviewKind,
  Engine as ContractEngine,
} from "../contracts/runner-api.ts";
import type { WorkerContainerOverrides } from "../contracts/worker-container.ts";

export type Engine = ContractEngine;
export type ReviewKind = ContractReviewKind;

/** The engine that runs a job of a kind: PR-Agent for Diff, OpenCode for Dynamic. */
export const ENGINE_BY_KIND: Readonly<Record<ReviewKind, Engine>> = {
  diff: "pr-agent",
  dynamic: "opencode",
};

/** What a Trigger knows about the job it wakes the core for. Poll knows nothing, Webhook knows the job. */
export type JobHint = { jobId?: string; reviewKind?: ReviewKind };

/** Per Worker kind configuration the core passes through to the Launcher. */
export type LaunchConfig = {
  /** What the container spec lets a Launcher change per kind (the memory limit), `worker-container.v1.json`. */
  container?: WorkerContainerOverrides;
  /** The Launcher's own options (for example the size of a VM); the core does not read them. */
  launcher?: Record<string, string | number | boolean>;
};

/**
 * A VM a Launcher created for a job (#493): its name (the platform's, as it is stopped), the moment `create` returned and
 * the VM's own timeout, the platform's backstop. What the App needs to measure the VM's minutes.
 */
export type CreatedVm = {
  name: string;
  startedAt: Date;
  timeoutSeconds: number;
};

/** Everything a Launcher needs to start the Worker of one job. The credential is a secret: never log it. */
export type LaunchSpec = {
  appUrl: string;
  jobId: string;
  credential: string;
  kind: ReviewKind;
  /** How long the Worker may live, from the start. */
  timeoutSeconds: number;
  config: LaunchConfig;
  /**
   * #493: a Launcher that creates a VM calls this right after the create returned. The core reports the VM to the App,
   * best effort and in the background; the call returns at once and never throws, and nothing it does can fail the
   * launch. A Launcher that creates no VM never calls it.
   */
  onVmCreated?: (vm: CreatedVm) => void;
};

/**
 * The stable codes a Launcher reports; the core logs the code and nothing else of the error. `retryable`
 * says whether starting the same job again can succeed (a platform outage, a rate limit) or not (a snapshot
 * that is gone, an image that is not the configured one): it is false unless the Launcher knows better.
 * Either way the core releases the job and the App counts the failed launch as an attempt.
 */
export class LaunchError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, options: { retryable?: boolean } = {}) {
    super(code);
    this.name = "LaunchError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * What a probe found (contracts/probe-verdict.v1.json, `ProbeReport` without `ok`): `passed` (the canary
 * container advertises `opencode`), `denied` (it answered and does not: `reasons`) or `failed` (no answer was
 * read: `failure`). Only engines, stable reasons and a stable code; never text of the container or the platform.
 */
export type ProbeResult = {
  status: "passed" | "denied" | "failed";
  /** What the Launcher advertises now. */
  engines: Engine[];
  reasons: string[];
  failure?: string;
  /** ISO 8601, UTC. */
  checkedAt: string;
};

/**
 * How a Worker is started. `capabilities` names the engines this Launcher can run and fails closed (a Launcher that
 * cannot tell advertises nothing); the core intersects it with the engines the deployment is configured for.
 * `launch` resolves once the Worker has taken over the job (it heartbeats itself) and rejects, ideally with a
 * LaunchError, when it could not be started. It must stop what it started when `signal` aborts (the deadline, a lost
 * lease, a shutdown). `probe`, when there is one, runs the canary probe now (`POST /probe`, the deploy canary) and
 * never rejects; dispatch and claim never call it (#479).
 */
export interface Launcher {
  capabilities(signal: AbortSignal): Promise<readonly Engine[]>;
  launch(spec: LaunchSpec, signal: AbortSignal): Promise<void>;
  probe?(signal: AbortSignal): Promise<ProbeResult>;
}

/** Time the core waits through, so a test can move it by hand. `sleep` resolves early when `signal` aborts. */
export interface Clock {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export type CoreSettings = {
  /** The base URL of the App (RUNNER_API_URL). */
  appUrl: string;
  /** The dispatcher credential (RUNNER_TOKEN). A secret. */
  token: string;
  /** The pool: sent as X-Runner-Id, so the App counts the running jobs of this Dispatcher. */
  poolId: string;
  /** The pool cap sent with every claim, and the cap on launches in progress. */
  maxRunning: number;
  /** The engines this deployment is configured to serve. */
  engines: readonly Engine[];
  /** How long a Worker may live. */
  jobTimeoutSeconds: number;
  /** How long a launch may take, from the claim. */
  launchDeadlineSeconds: number;
  workerConfig: Readonly<Record<ReviewKind, LaunchConfig>>;
};

/**
 * The answer of the core. Only `started` has work left: `background` is the launch (it never rejects),
 * which the Trigger hands to the platform (`waitUntil`) after it has answered.
 */
export type HandleResult =
  | { outcome: "started"; background: Promise<void> }
  /** The App has nothing due for this call: a replay, a running or finished job, or the pool cap. */
  | { outcome: "ignored" }
  /** No configured engine of this deployment's Launcher can run that kind. */
  | { outcome: "not_capable" }
  | { outcome: "busy"; retryAfterSeconds: number }
  | { outcome: "unavailable"; retryAfterSeconds: number };

export interface DispatcherCore {
  handle(hint: JobHint): Promise<HandleResult>;
  /** Stops every launch in progress; each releases its job. For a graceful shutdown that ran out of time. */
  abort(): void;
}
