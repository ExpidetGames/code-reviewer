// SPDX-License-Identifier: Apache-2.0

// The vocabulary of usage records (src/usage/README.md): what one run consumed, kept per job so limits, the usage
// page and the operator API can count it. Pure: no database, no clock. The table is `usage_records`, the
// repository `src/db/repositories/usage-records-repository.ts`.
import type { JobOutcome } from "../jobs/job-types.ts";
import type { LlmAccessSource } from "../llm/access.ts";
import type { KeyMode } from "../workspaces/entitlements.ts";

/**
 * The life of a record. `reserved` from the claim of the job, then `settled` (the run is counted, with
 * the cost and tokens it reported) or `void` (no model was used, nothing is counted). `settled` and `void`
 * are final. `reserved` and `settled` count towards a limit, `void` does not.
 */
export const USAGE_STATES = ["reserved", "settled", "void"] as const;
export type UsageState = (typeof USAGE_STATES)[number];

/**
 * Why a record was settled without a report of its run. `no_result`: the job ended without any result from the
 * runner (it died, its lease ran out on the last attempt, it ran past the hard limit), so the model may have been
 * used and nobody can say how much: the record counts, with an unknown cost and unknown tokens. A run that
 * reported its usage, failed or not, has no reason.
 */
export const SETTLED_REASONS = ["no_result"] as const;
export type SettledReason = (typeof SETTLED_REASONS)[number];

/**
 * The error codes a job ends with when a runner held it and no result arrived (`lease_expired` and `timeout` are the
 * queue's own, `runner_shutdown` is a runner that was stopped and gave the job back on its last attempt). Any other
 * way for a job to end without `complete` (cancelled, replaced, never started, given back before the runner began)
 * made no model call anybody knows of: its record is void.
 */
export const NO_RESULT_JOB_ERROR_CODES = [
  "lease_expired",
  "timeout",
  "runner_shutdown",
] as const;

/** Whose key a run was made with. The same two values as the key mode of the entitlements. */
export type UsageKeyMode = KeyMode;

/** Cost is stored as a whole number of millionths of a US dollar. */
const MICRO_USD_PER_USD = 1_000_000;

/**
 * The largest cost or token count a record stores: the columns are 32 bit integers on Postgres. A larger number
 * is not a plausible measurement of one run; it is stored as unknown instead of failing the completion.
 */
export const MAX_STORED_AMOUNT = 2_147_483_647;

/**
 * `costUsd` times one million, rounded half up; null for a value no record can hold (not a finite
 * non-negative number, or more than a record stores). The product is cut to 15
 * significant digits first, so a binary value that sits just below a half (0.0000005 * 1e6) still
 * rounds up, as it would on paper.
 */
export function costUsdToMicroUsd(costUsd: number): number | null {
  if (!Number.isFinite(costUsd) || costUsd < 0) return null;
  const micro = Math.floor(
    Number((costUsd * MICRO_USD_PER_USD).toPrecision(15)) + 0.5,
  );
  return micro <= MAX_STORED_AMOUNT ? micro : null;
}

/** `own` for the workspace's key, `managed` for the operator's (the source of the resolved LLM access). */
export function keyModeOfAccessSource(source: LlmAccessSource): UsageKeyMode {
  return source === "operator" ? "managed" : "own";
}

/** What completing a job does to its record. */
export type UsageSettlement =
  | { state: "void" }
  | {
      state: "settled";
      /** Null when the runner could not measure it (a cost is never guessed). */
      costMicroUsd: number | null;
      promptTokens: number | null;
      completionTokens: number | null;
    };

type ReportedUsage = {
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  /** Null when the runner did not say (it is not needed to settle). */
  aiCalls: number | null;
};

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_STORED_AMOUNT
  );
}

/** The usage inside a stored result, or null when there is none or it is not what the runner API promises. */
function reportedUsage(result: unknown): ReportedUsage | null {
  if (typeof result !== "object" || result === null) return null;
  const usage = (result as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const { promptTokens, completionTokens, costUsd, aiCalls } = usage as Record<
    string,
    unknown
  >;
  if (!isCount(promptTokens) || !isCount(completionTokens)) return null;
  const calls = isCount(aiCalls) ? aiCalls : null;
  if (costUsd === null)
    return { promptTokens, completionTokens, costUsd: null, aiCalls: calls };
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0)
    return null;
  return { promptTokens, completionTokens, costUsd, aiCalls: calls };
}

/** A usage that shows no model call: no call and no token. */
function showsNoModelCall(usage: ReportedUsage): boolean {
  return (
    usage.aiCalls === 0 &&
    usage.promptTokens === 0 &&
    usage.completionTokens === 0
  );
}

/**
 * How a reported outcome settles the record of its job. A reported usage settles it, with its cost
 * (null when unknown) and tokens, whatever the outcome: a run that failed after it used the model still cost
 * what it cost (#273), and the cost of a run with an unpriced call is unknown, never zero. Without one, a run that
 * succeeded is still a run (settled, everything unknown), and a run that failed made no model call as far as
 * anybody can tell (void: checkout, configuration, a lost lease). A failed run whose usage shows no call at all
 * (what a runner of an earlier release reports for a command that never reached the model) is void too.
 */
export function settlementOfOutcome(outcome: JobOutcome): UsageSettlement {
  const usage = reportedUsage(outcome.result);
  if (usage === null)
    return outcome.ok
      ? {
          state: "settled",
          costMicroUsd: null,
          promptTokens: null,
          completionTokens: null,
        }
      : { state: "void" };
  if (!outcome.ok && showsNoModelCall(usage)) return { state: "void" };
  return {
    state: "settled",
    costMicroUsd:
      usage.costUsd === null ? null : costUsdToMicroUsd(usage.costUsd),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  };
}
