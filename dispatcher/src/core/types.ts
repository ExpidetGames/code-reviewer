// SPDX-License-Identifier: LicenseRef-Proprietary

// The vocabulary of the Dispatcher core: what a Trigger hands in, what a Launcher must offer and what the
// core answers. Platform-free: no Node module, no platform SDK (checked by platform-free.test.ts).
import type {
  ReviewKind as ContractReviewKind,
  Engine as ContractEngine,
} from "../contracts/runner-api.ts";
import type { WorkerContainerOverrides } from "../contracts/worker-container.ts";

export type Engine = ContractEngine;
/** A kind as the contract names it (and as a signed wake-up call or a claim answer may carry it). */
export type WireReviewKind = ContractReviewKind;
/**
 * A kind this Dispatcher serves: a launcher, a configuration and a pool exist for it. The contract knows one more
 * (`implementer`, #746) that a later change serves (#759); until then it is a `WireReviewKind` only, so no table of this
 * Dispatcher is keyed by it and no code path can take it for a Diff or Dynamic job.
 */
export type ReviewKind = Exclude<WireReviewKind, "implementer">;

/** Whether a kind from the wire is one this Dispatcher serves. */
export function isServedKind(kind: WireReviewKind): kind is ReviewKind {
  return (KNOWN_KINDS as readonly WireReviewKind[]).includes(kind);
}

/** Every kind of the contract (`ReviewKind` of runner-api.v1.json), in the order of the file: what a signed wake-up call may name. */
export const CONTRACT_REVIEW_KINDS = [
  "diff",
  "dynamic",
  "implementer",
] as const;

/** The engine that runs a job of a kind: PR-Agent for Diff, OpenCode for Dynamic, the Implementer's own for `implementer` (#746). */
export const ENGINE_BY_KIND: Readonly<Record<WireReviewKind, Engine>> = {
  diff: "pr-agent",
  dynamic: "opencode",
  implementer: "implementer",
};

/**
 * The job kinds this Dispatcher serves (#730). An app is allowed a subset of them (`AppSettings.kinds`); a later kind is
 * added here and in the contracts, never by the configuration of an app. `implementer` is in the contract but not in this
 * list yet (#759 adds it with its Launcher), so a wake-up call or a claim for it is refused and never run by another engine.
 */
export const KNOWN_KINDS: readonly ReviewKind[] = ["diff", "dynamic"];

/** The id of the app that is configured by the legacy variables (`RUNNER_API_URL`, `RUNNER_TOKEN`, ...). */
export const LEGACY_APP_ID = "reviewer";

/**
 * What a Trigger knows about the job it wakes the core for. `appId` is the app the verified signing key belongs to (#730):
 * never anything the request says. The core claims at that app and nowhere else.
 */
export type JobHint = {
  appId: string;
  jobId?: string;
  reviewKind?: WireReviewKind;
};

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
  /** The app the job belongs to (#730): the id of the registry entry that claimed it. */
  appId: string;
  /** The registry's URL of that app, never a value from a request. */
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

/**
 * The live job VMs of the platform, counted per app (the `tenant` tag; no tag is `reviewer`): the Dispatcher's own count of
 * what each app occupies, whatever the app says (#730). Rejects when the platform cannot be listed.
 */
export type LiveVmCounter = (
  signal: AbortSignal,
) => Promise<ReadonlyMap<string, number>>;

/** One app this Dispatcher serves (#730). The legacy variables define `reviewer`; `DISPATCHER_APPS` adds the others. */
export type AppSettings = {
  id: string;
  /** The base URL of the App (RUNNER_API_URL for `reviewer`). */
  url: string;
  /** The dispatcher credential of this app (RUNNER_TOKEN for `reviewer`). A secret. */
  token: string;
  /** The pool: sent as X-Runner-Id, so the App counts the running jobs of this Dispatcher. */
  poolId: string;
  /** The pool cap sent with every claim of this app, and the cap on its launches in progress. */
  maxRunning: number;
  /** The job kinds this app may submit and be given. Anything else is refused on both sides of the claim. */
  kinds: readonly ReviewKind[];
};

export type CoreSettings = {
  /** The apps this Dispatcher serves; at least one. */
  apps: readonly AppSettings[];
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
