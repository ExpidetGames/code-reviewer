// SPDX-License-Identifier: Apache-2.0

// The rule that a managed Dynamic run never settles with an unknown cost (#553; epic #489: "the managed key is never used
// with an unknown price"). On the managed key we pay, so the price is known before the job starts (the claim carries the
// confirmed book) and the runner ends the run with `dynamic_accounting_failed` when a call's cost cannot be read. A result
// that still claims a success with a null cost is not trusted: it is stored as that failure, which billing treats as our fault
// (free), instead of a success the customer would be charged minutes for while nobody can say what it cost us. A result that
// reports no usage at all is left as it is: that is how an older runner and a usage that was dropped as malformed arrive, and
// it settles with an unknown cost as it always did. Pure.
import type { RunnerResult } from "./contract.ts";

export const UNACCOUNTED_MANAGED_RUN_MESSAGE =
  "the cost of the run could not be accounted for";

/**
 * The result as it is stored: unchanged, unless the job ran on the operator's key, is a Dynamic review, claims to have
 * succeeded and reports a usage with a null cost. A failure keeps the runner's code: its cost may well be unknown, and the
 * code decides how it bills.
 */
export function withoutUnaccountedManagedSuccess(
  result: RunnerResult,
  job: { managed: boolean; reviewKind: string },
): RunnerResult {
  if (!job.managed || job.reviewKind !== "dynamic") return result;
  if (result.errorCode !== null) return result;
  if (result.usage === null || result.usage.costUsd !== null) return result;
  return {
    ...result,
    ok: false,
    errorCode: "dynamic_accounting_failed",
    errorMessage: UNACCOUNTED_MANAGED_RUN_MESSAGE,
  };
}
