// SPDX-License-Identifier: Apache-2.0

// The TypeScript side of contracts/runner-api.v1.json. The JSON file is the source of the format;
// these types and sets are written by hand and kept in line with it by
// integration-tests/compatibility/runner-api-contract.integration.test.ts (the sets are compared
// with the file, and real answers and the request checks are validated against it).
import type { ReviewCommand } from "../integrations/types.ts";
import type { JobStatus } from "../jobs/job-status.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import {
  RUNNER_ENGINES,
  type RunnerEngine,
} from "../jobs/runner-capabilities.ts";

export const RUNNER_API_VERSION = 1 as const;

/** The engines a runner may advertise in a claim (`Engine` in the contract). */
export const CLAIM_ENGINES = RUNNER_ENGINES;
export type ClaimEngine = RunnerEngine;

/**
 * What else a runner may say it understands in a claim (`features` in `ClaimRequest`, #279).
 * `dynamic_capabilities`: it reads `dynamic.capabilities` of a Dynamic job. A job field a previous-release
 * runner would refuse (its job input is closed) is only sent to a runner that names the feature.
 */
export const CLAIM_FEATURES = [
  "dynamic_capabilities",
  // #320: the caller is a Dispatcher and gets the split answer (`SplitClaimResponse`): a per-job
  // credential and no job input, no git token and no model key.
  "worker_credential",
  // #396: the runner stops gracefully when a heartbeat answers `job.superseded`. A running job is superseded by a
  // newer push only when its holder named it (#397); a Worker names it in its job details request.
  "supersede",
] as const;
export type ClaimFeature = (typeof CLAIM_FEATURES)[number];

/**
 * The request body of a claim: which engines the runner can run (absent/empty means `pr-agent`) and which
 * features it understands (absent means none).
 */
export type ClaimRequest = {
  engines?: ClaimEngine[];
  features?: ClaimFeature[];
  /** #322: claim exactly this job (a Dispatcher woken by the dispatch webhook). */
  jobId?: string;
  /** #322: the pool cap: 204 while this many jobs of the caller's `X-Runner-Id` are running. */
  maxRunning?: number;
};

/** #322: the range of `ClaimRequest.maxRunning`. */
export const MAX_RUNNING_RANGE = { min: 1, max: 1000 } as const;

/**
 * #322: what this app lists in `VersionResponse.features` (`KnownAppFeature` in the contract). A
 * Dispatcher reads the list before it claims, so an app that lacks one of them (a previous release,
 * which would ignore `jobId` and `maxRunning`) is never asked.
 */
export const APP_FEATURES = [
  "worker_api",
  "claim_by_job_id",
  "pool_cap",
  "release",
] as const;
export type AppFeature = (typeof APP_FEATURES)[number];

/** #322: 200 from `GET /api/runners/v1/version` (`VersionResponse`). */
export type VersionResponse = {
  version: typeof RUNNER_API_VERSION;
  appVersion: string;
  features: AppFeature[];
};

/**
 * #322: the body of `POST /api/runners/v1/jobs/{id}/release` (`ReleaseRequest`): the per-job credential of
 * the claim, why the job is given back and, optionally, how long it must not be offered again.
 */
export type ReleaseRequest = {
  credential: string;
  reason: string;
  retryAfterSeconds?: number;
};

/** #322: the range of `ReleaseRequest.retryAfterSeconds`. */
export const RELEASE_RETRY_AFTER_RANGE = { min: 1, max: 86_400 } as const;

/** #322: 200 from the release (`ReleaseResponse`). */
export type ReleaseResponse = {
  version: typeof RUNNER_API_VERSION;
  job: { id: string; status: "queued" | "failed" };
};

/**
 * #364: 200 from `GET /api/runners/v1/jobs/{id}` (`JobStateResponse`): the status of a job and nothing else, for a
 * Dispatcher that decides whether the VM of a job is a leftover.
 */
export type JobStateResponse = {
  version: typeof RUNNER_API_VERSION;
  job: {
    id: string;
    status: JobStatus;
    /** #397: a superseded job whose claim is still valid (its Worker drains). Left out otherwise. */
    draining?: true;
  };
};

/** The path prefix of this version; the version is part of the URL. */
export const RUNNER_API_PATH = "/api/runners/v1" as const;

/** #320: the path prefix of the Worker API, which a per-job credential (not the runner token) opens. */
export const WORKER_API_PATH = "/api/workers/v1" as const;

/** #320: how many times the Worker of one claim may fetch the job details (each mints a fresh token). */
export const MAX_WORKER_FETCHES = 3;

/** Every request body is read up to this size; a larger one is refused with 413. */
export const RUNNER_MAX_BODY_BYTES = 64 * 1024;

/** How often a runner should send a heartbeat (the lease is four times as long). */
export const HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * The environment variables a job may carry: the options of the PR-Agent tools, one option name per
 * key (a second `__` would address a nested value). The app only ever sends the review tool's family
 * (`toRunnerSettings`); the removed tools' families are accepted for v1 compatibility with a
 * previous-release app and ignored by the runner. The same pattern as `propertyNames` of `JobEnv` in
 * the contract and as the runner's `_ENV_KEY` (a test compares it with the contract).
 */
export const RUNNER_ENV_KEY_PATTERN =
  /^(PR_REVIEWER|PR_DESCRIPTION|PR_CODE_SUGGESTIONS|PR_QUESTIONS)__[A-Z0-9]+(_[A-Z0-9]+)*$/;

/** Error codes the runner reports in a result (`KnownRunnerErrorCode` in the contract). */
export const RUNNER_ERROR_CODES = [
  "invalid_job",
  "invalid_command",
  "pr_agent_version_mismatch",
  "identity_patch_failed",
  "runner_error",
  "command_failed",
  "review_not_published",
  "review_state_truncated",
  "review_text_truncated",
  "pr_not_found",
  "git_auth",
  "git_forbidden",
  "git_rate_limit",
  "git_unavailable",
  "git_unprocessable",
  "git_provider_init",
  "llm_auth",
  "llm_quota",
  "llm_rate_limit",
  "llm_timeout",
  "llm_unavailable",
  "llm_bad_request",
  "llm_context_length_exceeded",
  "llm_output_invalid",
  "model_unknown",
  "timeout",
  "runner_shutdown",
  "unknown",
  // Dynamic Review (#195). Stable codes a caller may branch on; never a fallback to Diff.
  "dynamic_engine_unavailable",
  "dynamic_isolation_self_check_failed",
  "dynamic_config_invalid",
  "checkout_incomplete",
  "dynamic_policy_violation",
  "dynamic_budget_exceeded",
  "dynamic_accounting_failed",
  "dynamic_model_features_unsupported",
  "lease_lost",
  // #396: the run was replaced by a newer push; it stopped gracefully and reports what it used.
  "superseded",
] as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

/**
 * Why a Dynamic Review checkout failed (`KnownCheckoutReason` in the contract), reported next to the
 * code `checkout_incomplete`. A reader accepts any name of the right form and shows an unknown one
 * with a general sentence.
 */
export const RUNNER_CHECKOUT_REASONS = [
  "invalid_request",
  "ref_moved",
  "ref_missing",
  "protocol",
  "pack_invalid",
  "object_missing",
  "tree_invalid",
  "entries",
  "path_invalid",
  "budget_transfer",
  "budget_preparation",
  "budget_exposed",
  "diff_too_large",
  "input_too_large",
  "cancelled",
  "timeout",
  "transport",
  "isolation",
  "context",
] as const;
export type RunnerCheckoutReason = (typeof RUNNER_CHECKOUT_REASONS)[number];

/** The codes the API answers with (`ApiErrorCode` in the contract). */
export const RUNNER_API_ERROR_CODES = [
  "RUNNER_UNAUTHORIZED",
  "RUNNER_ID_INVALID",
  "RUNNER_REQUEST_INVALID",
  "RUNNER_JOB_NOT_FOUND",
  "RUNNER_LEASE_LOST",
  "RUNNER_RESULT_CONFLICT",
  "RUNNER_BODY_TOO_LARGE",
  "RUNNER_GIT_ACCESS_UNAVAILABLE",
  "RUNNER_INTERNAL_ERROR",
  // The Worker API (#318, served from #320): a credential that is not the job's, and a job the app ended.
  "WORKER_CREDENTIAL_INVALID",
  "RUNNER_JOB_ENDED",
] as const;
export type RunnerApiErrorCode = (typeof RUNNER_API_ERROR_CODES)[number];

export type FieldErrorCode = "required" | "invalid" | "too_long";
export type FieldError = { field: string; code: FieldErrorCode };

export type ErrorResponse = {
  error: {
    code: RunnerApiErrorCode;
    message: string;
    fields?: FieldError[];
    retryAfterSeconds?: number;
  };
};

/** The review kind of a job (`ReviewKind` in the contract). Diff is the legacy shape. */
export type ReviewKind = ProjectReviewKind;

/**
 * The Dynamic options of a tagged job (#195). Only model/skill/limits: the fixed core, the tools, the
 * permissions, the endpoints and the executable command are runner-owned and never arrive here. The
 * skill is literal data.
 */
export type DynamicReviewOptions = {
  model: string;
  skill: string;
  limits: { maxFindings: number };
  /**
   * #279: what the provider's model metadata says the model can do. Optional and sent only to a runner
   * that advertised the `dynamic_capabilities` feature; a previous-release runner has a closed job
   * contract and would refuse the key.
   */
  capabilities?: DynamicModelCapabilities;
};

/** `DynamicModelCapabilities` in the contract. Prices are exact decimal text, US dollars per million tokens. */
export type DynamicModelCapabilities = {
  toolChoiceRequired: boolean;
  structuredOutput: boolean;
  maxOutputTokens: number;
  contextWindowTokens: number;
  inputUsdPerMtok?: string;
  outputUsdPerMtok?: string;
};

/**
 * The checkout facts a Dynamic job carries (#195/#196), all pinned when the job was queued or claimed.
 * `comparison` is the declared comparison mode; it is a hint for preparation, never proof that the
 * comparison is complete — the runner's checkout verifies that before it trusts it.
 */
export type ClaimBase = {
  repository: string;
  baseRef: string;
  headSha: string;
  previousReviewedSha: string | null;
  /** #255: heads of earlier jobs of the pull request that did not succeed, newest first; absent when none. */
  attemptedShas?: string[];
  /**
   * #257: true when more heads were attempted than `attemptedShas` holds; absent means false. Only
   * `true` or absent on purpose: the app is stricter than the contract (the schema and the runner
   * accept a boolean), and a runner from before #257 rejects the key, so `false` is never sent.
   */
  attemptedShasTruncated?: true;
  comparison: "full" | "incremental";
};

/** The job as the runner reads it on stdin. Contains secrets: only the claim response has it. */
export type RunnerJobInput = {
  prUrl: string;
  command: ReviewCommand;
  /**
   * #195: absent means Diff, the legacy shape. `dynamic` is only sent to a runner that advertised
   * `opencode`; a previous-release runner never receives it.
   */
  reviewKind?: ReviewKind;
  /** Present exactly when `reviewKind` is `dynamic`. */
  dynamic?: DynamicReviewOptions;
  /** Checkout facts; present with `dynamic`. */
  base?: ClaimBase;
  git: {
    provider: "github";
    baseUrl: string;
    token: string;
    botLogin: string;
  };
  llm: {
    provider: "openrouter";
    model: string;
    apiKey: string;
    /** The token budget of the review; left out when neither the settings nor the instance set one. */
    maxTokens?: number;
    /** Not sent by the app in the MVP (no fallback chain). The runner accepts it. */
    fallbackModels?: string[];
  };
  env: Record<string, string>;
};

export type ClaimResponse = {
  version: typeof RUNNER_API_VERSION;
  job: {
    id: string;
    leaseToken: string;
    leaseExpiresAt: string;
    heartbeatIntervalSeconds: number;
    tokenExpiresAt: string | null;
    input: RunnerJobInput;
  };
};

/**
 * #320: the answer of a claim that names the feature `worker_credential` (`SplitClaimResponse`). The
 * Dispatcher gets the per-job credential and no job input: the git token and the model key reach only
 * the Worker, which fetches them with the credential (`WorkerJobDetailsResponse`).
 */
export type SplitClaimResponse = {
  version: typeof RUNNER_API_VERSION;
  job: {
    id: string;
    credential: string;
    reviewKind: ReviewKind;
    leaseExpiresAt: string;
    heartbeatIntervalSeconds: number;
  };
};

/** #320: 200 from `GET /api/workers/v1/jobs/{id}` (`WorkerJobDetailsResponse`). */
export type WorkerJobDetailsResponse = {
  version: typeof RUNNER_API_VERSION;
  job: {
    id: string;
    leaseExpiresAt: string;
    heartbeatIntervalSeconds: number;
    tokenExpiresAt: string | null;
    input: RunnerJobInput;
  };
};

/** #320: the body of `POST /api/workers/v1/jobs/{id}/result` (`WorkerResultRequest`). */
export type WorkerResultRequest = { result: RunnerResult };

export type HeartbeatRequest = { leaseToken: string };

export type HeartbeatResponse = {
  version: typeof RUNNER_API_VERSION;
  job: {
    id: string;
    heartbeatAt: string;
    leaseExpiresAt: string;
    /** #396: a newer push replaced this run (only for a claim that named the feature `supersede`). */
    superseded?: boolean;
  };
};

export type RunnerUsage = {
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  aiCalls: number;
  fallbackUsed: boolean;
  costUsd: number | null;
  /** Why a Dynamic Review was wrapped up before it was done (#293); null for a complete run. */
  stoppedEarly: StoppedEarly | null;
};

/** The reasons a Dynamic Review stops early: its cost limit or its time limit. */
export const STOPPED_EARLY_REASONS = ["cost_limit", "time_limit"] as const;
export type StoppedEarly = (typeof STOPPED_EARLY_REASONS)[number];

/** The result of a job as the runner reports it, after the checks and with every field filled. */
export type RunnerResult = {
  ok: boolean;
  durationMs: number;
  commentUrl: string | null;
  /** null if and only if `ok`. Any code of the right form is accepted; see `RUNNER_ERROR_CODES`. */
  errorCode: string | null;
  errorMessage: string | null;
  /**
   * The stable finer name of a failure (a `RUNNER_CHECKOUT_REASONS` entry for a checkout failure);
   * absent when the runner gave none. Any name of the right form is accepted.
   */
  errorReason?: string;
  logTail: string;
  logTruncated: boolean;
  usage: RunnerUsage | null;
};

export type CompleteRequest = { leaseToken: string; result: RunnerResult };

export type CompleteResponse = {
  version: typeof RUNNER_API_VERSION;
  /**
   * `queued`: the runner reported `runner_shutdown`, the job was given back and waits again (it fails
   * instead when that was the last allowed attempt).
   */
  job: {
    id: string;
    status: "succeeded" | "failed" | "queued" | "superseded";
  };
  alreadyCompleted: boolean;
};
