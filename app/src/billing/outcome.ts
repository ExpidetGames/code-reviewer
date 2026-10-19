// SPDX-License-Identifier: Apache-2.0

// How a run's end bills (ADR 0006, 2.6 and D7): a pure mapping from the end state of a job and its stable codes to one of
// three classes. Every terminal code of today is in a table, and a test fails when a code appears that has no class
// (`outcome.test.ts`: the job end codes, the error codes and checkout reasons of the runner contract, the release
// reasons, the reasons of a runner's loop and the settled reasons). The initial split follows the ADR and the decisions
// of the maintainer of 2026-10-19 (#489); it is flagged for him in the pull request of #494. No database, no clock.
import "server-only";
import type { JobErrorCode } from "../jobs/job-types.ts";
import type {
  RunnerCheckoutReason,
  RunnerErrorCode,
} from "../runner-api/contract.ts";
import type { SettledReason } from "../usage/usage-records.ts";
import type { KeyMode } from "../workspaces/entitlements.ts";

/**
 * - `charged`       the AI price (our key, a known cost) and the minutes.
 * - `minutes_only`  the minutes, never the AI price: the run ended without a result, or its cost is not attributable.
 * - `free`          nothing: an error on our side, or a job that never ran (void).
 */
export const OUTCOME_CLASSES = ["charged", "minutes_only", "free"] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/**
 * The class of a run that failed after it used the model, with no result delivered. OPEN QUESTION for the maintainer
 * (the review of #520, B2): ADR 0006, 2.6 row 2 bills it AI and minutes (`charged`, today); decision 1 of 2026-10-19 ("a
 * review that ends without a result but already incurred AI cost bills the minutes only"), read literally, makes it
 * `minutes_only`. The answer is this one line.
 */
export const AI_COST_FAILURE_CLASS = "charged" as const;

/** The codes that get `AI_COST_FAILURE_CLASS`: the model was used, the run ended without a result of the review. */
export const AI_COST_FAILURE_CODES = [
  "command_failed",
  "dynamic_budget_exceeded",
  "dynamic_policy_violation",
  "llm_bad_request",
  "llm_context_length_exceeded",
] as const;

/** The codes that arrive through the release call of a Dispatcher (`KnownReleaseReason` in the contract). */
type ReleaseReason = "launch_failed" | "worker_exited";

/**
 * Job end codes (`JOB_ERROR_CODES`), release reasons and the error codes of the runner contract. An exhaustive record:
 * a code added to one of those lists fails the typecheck here, and a code of the contract file fails the test.
 */
export const ERROR_CODE_CLASSES = {
  // The queue's own codes. A job that ended before it ran, or was refused at claim, is void.
  lease_expired: "free",
  // A timeout caused by us bills nothing (decision 1). The queue ends a job 25 minutes after the claim, the runner at 20;
  // Dynamic stops at 600 s on its own and Diff clips the diff, so a stall is never the size of the pull request.
  timeout: "free",
  project_deactivated: "free",
  pull_request_closed: "free",
  pull_request_draft: "free",
  review_kind_changed: "free",
  no_capable_runner: "free",
  dynamic_review_disabled: "free",
  command_removed: "free",
  dispatch_unavailable: "free",
  workspace_suspended: "free",
  quota_exhausted: "free",
  entitlements_invalid: "free",
  // The Dispatcher gave the job back.
  launch_failed: "free",
  worker_exited: "free",
  // The runner's codes. The job was refused before PR-Agent ran, or the runner itself failed: ours.
  invalid_job: "free",
  invalid_command: "free",
  pr_agent_version_mismatch: "free",
  identity_patch_failed: "free",
  runner_error: "free",
  runner_shutdown: "free",
  lease_lost: "free",
  // PR-Agent ran and handled a failure itself; the model was used (`AI_COST_FAILURE_CODES`).
  command_failed: AI_COST_FAILURE_CLASS,
  // The model worked, but nothing reached the pull request or nothing could be made of its answer: no result.
  review_not_published: "minutes_only",
  llm_output_invalid: "minutes_only",
  unknown: "minutes_only",
  // A review that was delivered, cut to GitHub's size limit.
  review_state_truncated: "charged",
  review_text_truncated: "charged",
  // The pull request is the customer's side of the line. The Git access is not attributable: a revoked installation is the
  // customer's, our own App token is ours.
  pr_not_found: "charged",
  git_auth: "minutes_only",
  git_forbidden: "minutes_only",
  git_unprocessable: "charged",
  // GitHub's availability and our own use of it are not the customer's.
  git_rate_limit: "free",
  git_unavailable: "free",
  git_provider_init: "free",
  // The model provider: an outage or a limit of capacity is ours; what the request or the customer's pull request
  // caused is the customer's. The key, the account, the model and the rate limit of the key are ours when the managed key
  // is used (`OURS_ON_MANAGED_KEY`), the customer's on their own key. A timeout of a call is the provider's: ours.
  llm_rate_limit: "charged",
  llm_unavailable: "free",
  llm_timeout: "free",
  llm_bad_request: AI_COST_FAILURE_CLASS,
  llm_context_length_exceeded: AI_COST_FAILURE_CLASS,
  llm_auth: "charged",
  llm_quota: "charged",
  model_unknown: "charged",
  llm_parameters_unsupported: "charged",
  // Dynamic Review.
  dynamic_engine_unavailable: "free",
  dynamic_isolation_self_check_failed: "free",
  dynamic_accounting_failed: "free",
  dynamic_config_invalid: "charged",
  dynamic_policy_violation: AI_COST_FAILURE_CLASS,
  dynamic_budget_exceeded: AI_COST_FAILURE_CLASS,
  dynamic_model_features_unsupported: "charged",
  checkout_incomplete: "charged",
  // Replaced by a newer push; it reported what it used. Not a failure of the job.
  superseded: "charged",
} as const satisfies Record<
  JobErrorCode | RunnerErrorCode | ReleaseReason,
  OutcomeClass
>;
export type ClassifiedCode = keyof typeof ERROR_CODE_CLASSES;

/** Codes that are an error on our side when the run used the operator's key, and the customer's on their own key. */
export const OURS_ON_MANAGED_KEY: readonly ClassifiedCode[] = [
  "llm_rate_limit",
  "llm_auth",
  "llm_quota",
  "model_unknown",
  "llm_parameters_unsupported",
  "dynamic_model_features_unsupported",
];

/** Why a Dynamic Review checkout failed (`checkout_incomplete`): the finer name refines the class of the code. */
export const CHECKOUT_REASON_CLASSES = {
  // Our own request, the transport to the Git server, the isolation we could not prove, a checkout that was stopped.
  invalid_request: "free",
  protocol: "free",
  pack_invalid: "free",
  cancelled: "free",
  timeout: "free",
  transport: "free",
  isolation: "free",
  context: "free",
  // What the repository or the pull request is.
  ref_moved: "charged",
  ref_missing: "charged",
  object_missing: "charged",
  tree_invalid: "charged",
  entries: "charged",
  path_invalid: "charged",
  budget_transfer: "charged",
  budget_preparation: "charged",
  budget_exposed: "charged",
  diff_too_large: "charged",
  input_too_large: "charged",
} as const satisfies Record<RunnerCheckoutReason, OutcomeClass>;

/**
 * The finer names the loop of a runner gives for a process it had to end (`NO_RESULT_ERROR_REASONS`): the model may have
 * been used and nobody can say how much.
 */
export const RESULT_REASON_CLASSES = {
  no_result_from_process: "minutes_only",
  unreadable_usage: "minutes_only",
} as const satisfies Record<string, OutcomeClass>;

/** Why a usage record was settled without a report of its run. */
export const SETTLED_REASON_CLASSES = {
  no_result: "minutes_only",
  superseded: "charged",
} as const satisfies Record<SettledReason, OutcomeClass>;

/** The end of a run, as the job and its usage record state it. */
export type RunEnd = {
  /** The terminal status of the job. */
  status: "succeeded" | "failed" | "cancelled" | "superseded";
  /** `jobs.error_code`: a job end code or the code the runner reported. */
  errorCode: string | null;
  /** The finer name the runner reported next to the code (`errorReason`). */
  errorReason?: string | null;
  /** `usage_records.settled_reason`. */
  settledReason?: SettledReason | string | null;
  /** Whose key the run was made with. */
  keyMode: KeyMode;
};

// From the dearest to the cheapest for the customer: when several facts apply, the cheapest wins.
const RANK: Record<OutcomeClass, number> = {
  free: 0,
  minutes_only: 1,
  charged: 2,
};

function cheaper(a: OutcomeClass, b: OutcomeClass): OutcomeClass {
  return RANK[a] <= RANK[b] ? a : b;
}

function lookup<T extends string>(
  table: Record<T, OutcomeClass>,
  key: string | null | undefined,
): OutcomeClass | undefined {
  if (key === null || key === undefined) return undefined;
  return Object.hasOwn(table, key) ? table[key as T] : undefined;
}

function classOfCode(code: string | null, keyMode: KeyMode): OutcomeClass {
  // A code this build does not know (a newer runner) is not attributable: the minutes, never the AI.
  const known = lookup<ClassifiedCode>(ERROR_CODE_CLASSES, code);
  if (known === undefined) return "minutes_only";
  if (
    keyMode === "managed" &&
    OURS_ON_MANAGED_KEY.includes(code as ClassifiedCode)
  )
    return "free";
  return known;
}

/** A job replaced by a newer push: it has a run only when its usage record was marked (or settled) as superseded. */
function classOfSuperseded(end: RunEnd): OutcomeClass {
  return end.settledReason === "superseded" ? "charged" : "free";
}

/**
 * The class of a run's end. A delivered result is charged and a cancelled job is void. Otherwise the code of a failure,
 * the finer reason and the settled reason each give a class, and the cheapest for the customer wins (a run that was our
 * error and also left no result is ours). A superseded run that began (its usage record says `superseded`) starts as
 * charged: what it reported is billed, and an unknown cost leaves only the minutes (the price of a run, `priceRun`). A
 * queued job superseded before it ran has no run and is free. Never throws: a code or reason it does not know is treated
 * as not attributable (`minutes_only`).
 */
export function classifyOutcome(end: RunEnd): OutcomeClass {
  if (end.status === "succeeded") return "charged";
  if (end.status === "cancelled") return "free";
  let outcome: OutcomeClass =
    end.status === "superseded" && end.errorCode === null
      ? classOfSuperseded(end)
      : classOfCode(end.errorCode, end.keyMode);
  if (end.errorCode === "checkout_incomplete") {
    // A reason this build does not know (a newer runner) is not attributable, like an unknown code. No reason at all
    // leaves the class of the code.
    const refined = lookup(CHECKOUT_REASON_CLASSES, end.errorReason);
    if (refined !== undefined) outcome = cheaper(outcome, refined);
    else if (end.errorReason !== null && end.errorReason !== undefined)
      outcome = cheaper(outcome, "minutes_only");
  }
  const loop = lookup(RESULT_REASON_CLASSES, end.errorReason);
  if (loop !== undefined) outcome = cheaper(outcome, loop);
  const settled = lookup(SETTLED_REASON_CLASSES, end.settledReason);
  if (settled !== undefined) outcome = cheaper(outcome, settled);
  return outcome;
}
