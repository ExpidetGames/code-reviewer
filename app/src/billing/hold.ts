// SPDX-License-Identifier: Apache-2.0

// What a hold is made for (ADR 0006, 2.8 and D6; #498): the longest a job can occupy a VM, and the most its model cost can
// be bounded to. Constants because the App cannot read the settings of a Dispatcher or of a runner; each is the default of
// the place that owns it, and a test pins it there (`hold.test.ts` reads those places, and
// `dispatcher/src/billing-hold-pin.test.ts` reads this file). An operator who raises a setting above its default makes the
// hold smaller than the real maximum, never larger; the settlement charges the real price in any case.
import "server-only";
import type { ProjectReviewKind } from "../review-settings/settings.ts";

/** `DISPATCHER_JOB_TIMEOUT_SECONDS` of the Dispatcher (`dispatcher/src/config.ts`): how long a Worker of a Diff job may live. */
export const DIFF_JOB_TIMEOUT_SECONDS = 1200;
/**
 * The same setting for a Dynamic job. Its engine stops at 600 s on its own, but the VM is sized by the Dispatcher's one
 * timeout whatever the kind, so that is the longest it lives.
 */
export const DYNAMIC_JOB_TIMEOUT_SECONDS = 1200;
/** `SANDBOX_VM_TIMEOUT_MARGIN_SECONDS` of the Dispatcher (`dispatcher/src/launchers/sandbox.ts`): the VM's own timeout is the job's plus this. */
export const VM_TIMEOUT_MARGIN_SECONDS = 300;

export const JOB_TIMEOUT_SECONDS: Record<ProjectReviewKind, number> = {
  diff: DIFF_JOB_TIMEOUT_SECONDS,
  dynamic: DYNAMIC_JOB_TIMEOUT_SECONDS,
};

/**
 * The cost limit of a Dynamic run in micro-USD: the default of `RUNNER_DYNAMIC_MAX_COST_USD`
 * (`runner/src/code_reviewer_runner/dynamic_review/budget.py`, 1.00 USD). The App does not know the operator's value; a run
 * can cost more than this limit by the excess of #540, and then settlement charges the real price.
 */
export const DYNAMIC_COST_LIMIT_MICRO_USD = 1_000_000;

const MINUTE_SECONDS = 60;

/** The longest a VM of a job of this kind lives, in whole started minutes: the job timeout plus the VM margin, rounded up. */
export function maxVmMinutes(kind: ProjectReviewKind): number {
  return Math.ceil(
    (JOB_TIMEOUT_SECONDS[kind] + VM_TIMEOUT_MARGIN_SECONDS) / MINUTE_SECONDS,
  );
}
