// SPDX-License-Identifier: LicenseRef-Proprietary

// The most one review may cost, set by the operator (#689): the instance setting `review_max_cost_cents`, edited in the admin
// portal. It is the customer's maximum: a customer's own cost limit (`maxCostCents`, #656) can only be lower, and the limit of a
// job is the smaller of the two. It holds for both kinds of review. The default is 1.00 US dollar, what the runner's own limit
// for Dynamic Review was (`RUNNER_DYNAMIC_MAX_COST_USD`, which is now only the fallback of a runner whose app does not send
// the value). A stored value that is not valid reads as the default, never as no limit: a damaged setting must not unbind a
// review. Pure.
import { REVIEW_SETTING_LIMITS } from "./settings.ts";

export const DEFAULT_OPERATOR_COST_LIMIT_CENTS = 100;
/** The same bounds as a customer's limit: one cent to one hundred US dollars. */
export const OPERATOR_COST_LIMIT_BOUNDS = REVIEW_SETTING_LIMITS.maxCostCents;

export type OperatorCostLimitCheck =
  { ok: true; value: number } | { ok: false; code: "number_out_of_range" };

/** A whole number of US cents within the bounds, or `number_out_of_range`. */
export function checkOperatorCostLimit(value: unknown): OperatorCostLimitCheck {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < OPERATOR_COST_LIMIT_BOUNDS.min ||
    value > OPERATOR_COST_LIMIT_BOUNDS.max
  )
    return { ok: false, code: "number_out_of_range" };
  return { ok: true, value };
}

/** The maximum a stored setting stands for, in cents: the value when valid, else the default. */
export function operatorCostLimitCentsOf(stored: unknown): number {
  const checked = checkOperatorCostLimit(stored);
  return checked.ok ? checked.value : DEFAULT_OPERATOR_COST_LIMIT_CENTS;
}
