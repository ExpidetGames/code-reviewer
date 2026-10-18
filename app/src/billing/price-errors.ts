// SPDX-License-Identifier: Apache-2.0

// The stable codes of a refused price link (#439) and the HTTP status of each. The plans page translates a code to copy
// (src/admin/ui/plans-messages.ts), never the other way round. The rule codes are those of the price checks
// (`price-rules.ts`), the Paddle codes those of any call to Paddle on the admin's behalf (`admin-errors.ts`). A refusal
// never carries a Paddle answer or a key: only a code, the field to blame and, for a mismatch, the two values.
import "server-only";
import {
  BILLING_CHECK_ERROR_CODES,
  BILLING_ERROR_STATUS,
  type BillingCheckErrorCode,
} from "./admin-errors.ts";
import {
  PRICE_RULE_ERROR_CODES,
  type PriceRuleErrorCode,
} from "./price-rules.ts";

export const PRICE_LINK_ERROR_CODES = [
  ...PRICE_RULE_ERROR_CODES,
  /** The body is not `{ versionNumber, interval, paddlePriceId }`; nothing else is read, least of all an amount. */
  "price_input_invalid",
  /** Not a Paddle price id (`pri_` and letters or digits). */
  "price_id_invalid",
  /** This Paddle price is linked to another plan. */
  "price_used_by_other_plan",
  /** Only a paid plan has prices. */
  "price_plan_not_paid",
  /** A slot that has a price is relinked to another price; it is never emptied. */
  "price_link_not_clearable",
  /** Another admin linked another price to this slot meanwhile; reload and decide again. */
  "price_link_changed",
  /** The amount stored for the slot is not a positive whole number of minor units; nothing is sent to Paddle (#440). */
  "price_amount_invalid",
  /** Trial days are whole days, from 1 to a year. */
  "price_trial_invalid",
  /** Another request is creating this price, or an attempt that died is not old enough to take over yet. */
  "price_creation_pending",
  /** Paddle refused to create the product or the price. */
  "price_create_rejected",
  /** The price is the one the current version is sold with: archiving it would end the sale. */
  "price_in_use",
  /** A live subscription still uses the price: it stays active at Paddle. */
  "price_has_subscribers",
  ...BILLING_CHECK_ERROR_CODES,
] as const;
export type PriceLinkErrorCode = (typeof PRICE_LINK_ERROR_CODES)[number];

/** A price a refresh could not read: which one, and why (the code of the failure, never Paddle's text). */
export type PriceReadFailure = {
  paddlePriceId: string;
  code: PriceRefusal["code"];
};

/** What a refused link or refresh reports. `plan_not_found`, `plan_archived` and `plan_changed` are the plan codes. */
export type PriceRefusal = {
  code:
    | PriceRuleErrorCode
    | BillingCheckErrorCode
    | "price_input_invalid"
    | "price_id_invalid"
    | "price_used_by_other_plan"
    | "price_plan_not_paid"
    | "price_link_not_clearable"
    | "price_link_changed"
    | "price_amount_invalid"
    | "price_trial_invalid"
    | "price_creation_pending"
    | "price_create_rejected"
    | "price_in_use"
    | "price_has_subscribers"
    | "plan_not_found"
    | "plan_archived"
    | "plan_changed";
  field?: string;
  /** For a mismatch: what the version holds and what Paddle says. */
  entered?: string;
  paddle?: string;
  /** For a refresh that could not read every price: each price that failed. `code` is the first one's. */
  failures?: PriceReadFailure[];
};

type RuleStatus = Record<PriceRuleErrorCode, number>;
const RULE_STATUS: RuleStatus = {
  price_not_found: 422,
  price_not_active: 422,
  price_type_unsupported: 422,
  price_not_recurring: 422,
  price_amount_mismatch: 422,
  price_interval_mismatch: 422,
  price_currency_mismatch: 422,
  price_tax_mode_mismatch: 422,
  price_has_overrides: 422,
  price_quantity_unsupported: 422,
  price_product_mismatch: 422,
  price_environment_mismatch: 422,
  price_yearly_not_entered: 422,
};

export const PRICE_ERROR_STATUS: Record<PriceRefusal["code"], number> = {
  ...RULE_STATUS,
  price_input_invalid: 422,
  price_id_invalid: 422,
  price_used_by_other_plan: 409,
  price_plan_not_paid: 422,
  price_link_not_clearable: 422,
  price_link_changed: 409,
  price_amount_invalid: 422,
  price_trial_invalid: 422,
  price_creation_pending: 409,
  price_create_rejected: 502,
  price_in_use: 409,
  price_has_subscribers: 409,
  plan_not_found: 404,
  plan_archived: 409,
  plan_changed: 409,
  api_key_missing: BILLING_ERROR_STATUS.api_key_missing,
  api_key_unreadable: BILLING_ERROR_STATUS.api_key_unreadable,
  paddle_key_rejected: BILLING_ERROR_STATUS.paddle_key_rejected,
  paddle_rate_limited: BILLING_ERROR_STATUS.paddle_rate_limited,
  paddle_unreachable: BILLING_ERROR_STATUS.paddle_unreachable,
  paddle_unavailable: BILLING_ERROR_STATUS.paddle_unavailable,
};
