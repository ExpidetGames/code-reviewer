// SPDX-License-Identifier: LicenseRef-Proprietary

// The cost limit field of the form (#756): dollars as a person types them, whole cents as the route takes them. An amount above the
// operator's maximum is refused here, before anything is sent; the server checks it again.
import { REVIEW_SETTING_LIMITS } from "../../review-settings/settings.ts";

/** Dollars as typed: "2", "1.50", ".5", each with an optional leading "$". */
const DOLLARS = /^\$?(\d+(\.\d{1,2})?|\.\d{1,2})$/;

export type CostLimitCheck =
  /** `cents` is null when the field is empty: no limit of the person's own, the maximum applies. */
  | { ok: true; cents: number | null }
  | { ok: false; code: "invalid" }
  | { ok: false; code: "above_maximum"; maximumCents: number };

/** What the text means. `maximumCents` is the operator's maximum per task. */
export function parseCostLimit(
  text: string,
  maximumCents: number,
): CostLimitCheck {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, cents: null };
  if (!DOLLARS.test(trimmed)) return { ok: false, code: "invalid" };
  const cents = Math.round(Number(trimmed.replace("$", "")) * 100);
  const limits = REVIEW_SETTING_LIMITS.maxCostCents;
  if (cents < limits.min) return { ok: false, code: "invalid" };
  if (cents > maximumCents)
    return { ok: false, code: "above_maximum", maximumCents };
  if (cents > limits.max) return { ok: false, code: "invalid" };
  return { ok: true, cents };
}

/** What the empty field means and shows: "Max $5.00". */
export function costLimitPlaceholder(maximumCents: number): string {
  return `Max $${(maximumCents / 100).toFixed(2)}`;
}
