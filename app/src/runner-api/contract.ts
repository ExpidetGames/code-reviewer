// SPDX-License-Identifier: Apache-2.0

// The TypeScript side of contracts/runner-api.v1.json. The JSON file is the source of the format;
// these types and sets are written by hand and kept in line with it by
// integration-tests/compatibility/runner-api-contract.integration.test.ts (the sets are compared
// with the file, and real answers and the request checks are validated against it).
import type { ReviewCommand } from "../integrations/types.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import {
  RUNNER_ENGINES,
  type RunnerEngine,
} from "../jobs/runner-capabilities.ts";

export const RUNNER_API_VERSION = 1 as const;

/** The engines a runner may advertise in a claim (`Engine` in the contract). */
export const CLAIM_ENGINES = RUNNER_ENGINES;
export type ClaimEngine = RunnerEngine;

/** The request body of a claim: which engines the runner can run. Absent/empty means `pr-agent`. */
export type ClaimRequest = { engines?: ClaimEngine[] };

/** The path prefix of this version; the version is part of the URL. */
export const RUNNER_API_PATH = "/api/runners/v1" as const;

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
] as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

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

export type HeartbeatRequest = { leaseToken: string };

export type HeartbeatResponse = {
  version: typeof RUNNER_API_VERSION;
  job: { id: string; heartbeatAt: string; leaseExpiresAt: string };
};

export type RunnerUsage = {
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  aiCalls: number;
  fallbackUsed: boolean;
  costUsd: number | null;
};

/** The result of a job as the runner reports it, after the checks and with every field filled. */
export type RunnerResult = {
  ok: boolean;
  durationMs: number;
  commentUrl: string | null;
  /** null if and only if `ok`. Any code of the right form is accepted; see `RUNNER_ERROR_CODES`. */
  errorCode: string | null;
  errorMessage: string | null;
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
  job: { id: string; status: "succeeded" | "failed" | "queued" };
  alreadyCompleted: boolean;
};
