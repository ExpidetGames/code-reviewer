// SPDX-License-Identifier: Apache-2.0

// The copy for what the plans routes answer: one sentence per stable code (src/billing/plan-errors.ts and the entitlement
// codes). The codes are the contract, these sentences are only what the page shows.
import {
  CROSS_SITE_REQUEST,
  INVALID_VALUES,
  UNAVAILABLE,
} from "../../copy/messages.ts";
import { describePaddleAmount } from "./plans-format.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const FAILURE_COPY: Record<string, string> = {
  cross_site_request: CROSS_SITE_REQUEST,
  invalid_input: INVALID_VALUES,
  unavailable: UNAVAILABLE,
  plan_input_invalid: "Some of the values are not what this plan can hold.",
  plan_key_invalid:
    "A plan key is 2 to 32 characters: a lower case letter, then lower case letters, digits and hyphens.",
  plan_key_taken: "Another plan has this key. Choose a different one.",
  plan_kind_invalid: "Choose a paid plan or an Enterprise plan.",
  plan_name_invalid: "Enter a name of 1 to 64 printable characters.",
  plan_description_invalid:
    "The description is one line of at most 400 characters.",
  plan_sort_invalid: "Enter a whole number from 0 to 100000 for the order.",
  plan_price_invalid:
    "Enter the price in dollars and cents (at most two decimals), more than zero and at most 1,000,000. A paid plan needs a monthly price.",
  plan_price_not_allowed: "The Free plan and an Enterprise plan have no price.",
  popular_requires_paid_plan: "Only a paid plan can be marked Popular.",
  contact_target_required:
    "Enter the link or email address behind the Contact us button before this plan is offered.",
  contact_target_invalid:
    "Enter an https link, or an email address as mailto:name@example.com.",
  contact_target_not_allowed:
    "Only an Enterprise plan has a contact link or address.",
  own_plan_requires_paid_plan:
    "Only a paid plan can use the workspace's own key.",
  model_access_requires_managed_plan:
    "A plan that uses the workspace's own key has no model list: workspaces pick any model with their own keys.",
  free_plan_key_mode_fixed:
    "The Free plan always runs on our models. Its key mode cannot be changed.",
  plan_key_mode_invalid: "Choose our models or the workspace's own key.",
  contact_plan_has_no_versions:
    "An Enterprise plan has no limits, prices or versions.",
  plan_not_found: "This plan does not exist (any more). Reload the page.",
  free_plan_not_deletable: "The Free plan cannot be deleted.",
  plan_has_versions:
    "A plan that has versions cannot be deleted: its subscribers bought them. Archive it instead.",
  free_plan_not_archivable: "The Free plan cannot be archived.",
  plan_archived: "This plan is archived. Restore it first.",
  plan_version_unchanged:
    "Nothing changed compared with the current version, so no new version was created.",
  plan_changed:
    "The plan changed meanwhile, in another tab or by another admin. Reload the page and try again.",
  price_input_invalid:
    "The price could not be linked: choose a slot and enter a Paddle price ID.",
  price_id_invalid:
    "A Paddle price ID starts with pri_ and has only letters and digits after it.",
  price_not_found:
    "Paddle does not know this price. Check the ID and that it belongs to the Paddle environment billing is set to.",
  price_not_active:
    "This price is archived at Paddle. Use an active price, or create a new one in Paddle.",
  price_not_recurring:
    "This is a one-time price. A plan needs a price that renews every month or every year.",
  price_amount_mismatch:
    "The price at Paddle does not carry the amount entered for this version.",
  price_interval_mismatch:
    "The price does not renew every month for the monthly slot, or every year for the yearly slot.",
  price_currency_mismatch: "The price is not in US dollars.",
  price_tax_mode_mismatch:
    "The price is not tax inclusive. Its tax mode must be set to internal at Paddle, not to the account setting.",
  price_type_unsupported:
    "The price is a custom price, made for a single transaction. Use a standard price from the Paddle catalog.",
  price_has_overrides:
    "The price has country specific prices. Use a price without overrides.",
  price_quantity_unsupported:
    "The price has a minimum quantity above one, or a maximum below one. A subscription is bought with a quantity of one: set the minimum to 1 at Paddle.",
  price_product_mismatch:
    "The price belongs to another Paddle product than the one this plan is sold under.",
  price_environment_mismatch:
    "This plan or price is from the other Paddle environment (sandbox or live) than the one billing is set to.",
  price_yearly_not_entered:
    "This version has no yearly price entered, so there is no yearly price to link. Enter one as a new version first.",
  price_used_by_other_plan: "This Paddle price is linked to another plan.",
  price_plan_not_paid: "Only a paid plan has Paddle prices.",
  price_link_not_clearable:
    "A price that is linked cannot be removed from its slot, only replaced by another price.",
  price_link_changed:
    "Another admin linked a different price to this slot meanwhile. Reload the page and decide again.",
  api_key_missing: "Store the Paddle API key in the billing settings first.",
  api_key_unreadable:
    "The stored Paddle API key cannot be read. Enter it again in the billing settings.",
  paddle_key_rejected:
    "Paddle did not accept the stored API key. Check it in the billing settings.",
  paddle_rate_limited: "Paddle asked the app to slow down. Try again shortly.",
  paddle_unreachable: "Paddle could not be reached. Try again shortly.",
  paddle_unavailable: "Paddle failed to answer. Try again shortly.",
  limits_invalid: "The limits are not valid.",
  limit_invalid: "Enter a whole number, or leave the field empty for no limit.",
  cost_limit_requires_managed_key:
    "The operator cost limit only counts runs on our key, so it does not apply to a plan that uses the workspace's own key.",
  catalog_entry_invalid: "Choose how this plan picks its models.",
  plan_label_invalid: "Enter a name of 1 to 64 printable characters.",
  key_mode_invalid: "Choose our models or the workspace's own key.",
};

/** The sentence for a failed change or call. */
export function describePlanFailure(code: string): string {
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

/** What a price that was refused or has drifted differs in, in words, with the two values (minor units as text) when given. */
export function describePriceDifference(
  code: string,
  values: { entered?: string; paddle?: string } = {},
): string {
  const { entered, paddle } = values;
  if (entered === undefined || paddle === undefined)
    return describePlanFailure(code);
  switch (code) {
    case "price_amount_mismatch":
      return `Paddle has ${describePaddleAmount(paddle)}, but ${describePaddleAmount(entered)} is entered for this version.`;
    case "price_interval_mismatch":
      return `Paddle renews every ${paddle}, but this slot is for every ${entered}.`;
    case "price_currency_mismatch":
      return `Paddle has the currency ${paddle}, but only ${entered} is supported.`;
    case "price_quantity_unsupported":
      return `Paddle allows a quantity of ${paddle} for this price, but a subscription is bought with a quantity of ${entered}: set the minimum to 1 at Paddle.`;
    case "price_tax_mode_mismatch":
      return `Paddle has the tax mode ${paddle}, but it must be ${entered} (tax inclusive).`;
    default:
      return describePlanFailure(code);
  }
}
