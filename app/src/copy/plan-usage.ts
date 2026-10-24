// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the plan and usage page of a workspace (#282). Fixed sentences: nothing in them is an amount of
// money, a price, a model, a reason for a pause or a name of a person. The plan label is the one operator-supplied
// text on the page and is shown as text (src/usage/ui/plan-usage.tsx), not written here.
import { NOTICE_WORKSPACE_SUSPENDED } from "./refusal-notice.ts";

export const PLAN_PAGE_TITLE = "Plan and usage";
export const PLAN_NAV_LABEL = "Plan";

/** For a workspace without entitlements, also reached by address. */
export const PLAN_NO_LIMITS = "No limits apply to this workspace.";

/** Entitlements exist but cannot be read: reviews are refused until the operator repairs them. */
export const PLAN_UNREADABLE =
  "The limits of this workspace cannot be read right now, so reviews are not started. Contact the operator.";

/** The workspace reviews with the operator's key. */
export const PLAN_MANAGED =
  "The models for your reviews are provided and billed via code-review.com.";

export const PLAN_PAUSED_TITLE = "Reviews are paused";
/** No reason is given on purpose. */
export const PLAN_PAUSED = NOTICE_WORKSPACE_SUSPENDED;
export const PLAN_PAUSED_DETAIL = "New reviews are not started.";

export const PLAN_CURRENT_HEADING = "Current plan";
export const PLAN_RUNS_HEADING = "Reviews in this period";
export const PLAN_COST_HEADING = "Usage limit";

export const PLAN_LABEL_TERM = "Plan";
export const PLAN_PERIOD_TERM = "Counting since";

export const PLAN_NO_LIMIT = "no limit";
export const PLAN_LIMIT_REACHED = "limit reached";

/** "3 of 5", "3 used, no limit". */
export function planRunsText(used: number, limit: number | null): string {
  const text =
    limit === null
      ? `${String(used)} used, ${PLAN_NO_LIMIT}`
      : `${String(used)} of ${String(limit)}`;
  return limit !== null && used >= limit
    ? `${text}, ${PLAN_LIMIT_REACHED}`
    : text;
}

/** The text equivalent of the bar. */
export function planCostText(percent: number): string {
  return `${String(percent)} % of the usage limit used`;
}
export const PLAN_COST_REACHED =
  "The limit is reached. New reviews are not started.";
export const PLAN_COST_SOFT_CAP =
  "The figure is not exact: usage is added when a review finishes, so it can trail behind, and a review that is already running can take the total slightly past the limit.";

export function planUnknownCostText(count: number): string {
  return count === 1
    ? "1 finished review could not be measured and is not in this percentage."
    : `${String(count)} finished reviews could not be measured and are not in this percentage.`;
}

export const PLAN_POLL_FAILED =
  "Updating failed. This page shows the last data it got; it keeps trying.";
export const PLAN_POLL_STOPPED_SUFFIX =
  " This page no longer updates; reload it to try again.";
