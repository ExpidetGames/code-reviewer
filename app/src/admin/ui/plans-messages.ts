// SPDX-License-Identifier: Apache-2.0

// The copy for what the plans routes answer: one sentence per stable code (src/billing/plan-errors.ts and the entitlement
// codes). The codes are the contract, these sentences are only what the page shows.
import {
  CROSS_SITE_REQUEST,
  INVALID_VALUES,
  UNAVAILABLE,
} from "../../copy/messages.ts";
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
    "Enter the price in dollars and cents (at most two decimals), more than zero. A paid plan needs a monthly price.",
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
