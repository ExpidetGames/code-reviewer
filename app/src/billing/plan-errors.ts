// SPDX-License-Identifier: Apache-2.0

// The stable codes of a refused plan change (#438) and the HTTP status of each. The plans page translates a code to
// copy (src/admin/ui/plans-messages.ts), never the other way round. A refusal of the entitlements validation (a limit,
// the model access, the operator cost limit next to the own key) keeps the code of that validation.
import "server-only";
import type { EntitlementErrorCode } from "../workspaces/entitlements-validation.ts";

export const PLAN_ERROR_CODES = [
  /** The body is not the object the route reads, or a field has the wrong type or is unknown; `field` names it. */
  "plan_input_invalid",
  /** A plan key is 2 to 32 characters: a lower case letter, then lower case letters, digits and hyphens. */
  "plan_key_invalid",
  "plan_key_taken",
  /** Only a `paid` or a `contact` plan is created; the one Free plan is seeded. */
  "plan_kind_invalid",
  "plan_name_invalid",
  "plan_description_invalid",
  "plan_sort_invalid",
  /** The monthly price is missing on a paid version, or an amount is not a positive integer in minor units. */
  "plan_price_invalid",
  /** A price on a `free` or `contact` plan. */
  "plan_price_not_allowed",
  /** Only a paid plan can be Popular. */
  "popular_requires_paid_plan",
  /** A `contact` plan cannot be offered without a link or address. */
  "contact_target_required",
  /** Not an https link or a `mailto:` address. */
  "contact_target_invalid",
  /** A contact target on a plan that is not a `contact` plan. */
  "contact_target_not_allowed",
  /** An `own` version needs a plan of kind `paid` (ADR 0005, M18). */
  "own_plan_requires_paid_plan",
  /** An `own` version has no model access. */
  "model_access_requires_managed_plan",
  /** The Free plan is `managed` and stays so (M18). */
  "free_plan_key_mode_fixed",
  /** A key mode other than `managed` and `own`. */
  "plan_key_mode_invalid",
  /** An Enterprise plan has no versions, no price and no checkout. */
  "contact_plan_has_no_versions",
  "plan_not_found",
  /** The Free plan is never deleted. */
  "free_plan_not_deletable",
  /** A plan with versions is archived, not deleted: its versions are what subscribers bought. */
  "plan_has_versions",
  /** The Free plan is the default of every workspace and is never archived. */
  "free_plan_not_archivable",
  /** An archived plan is not offered, popular or given a new version; restore it first. */
  "plan_archived",
  /** The terms are those of the current version: saving them would only repeat it. */
  "plan_version_unchanged",
  /** The plan changed since the page read it (another admin, another tab); nothing was written. */
  "plan_changed",
] as const;
export type PlanErrorCode = (typeof PLAN_ERROR_CODES)[number];

/** What a refused plan change reports: the code of this module or of the entitlements validation, and the field. */
export type PlanRefusal = {
  code: PlanErrorCode | EntitlementErrorCode;
  field?: string;
};

export const PLAN_ERROR_STATUS: Record<PlanErrorCode, number> = {
  plan_input_invalid: 422,
  plan_key_invalid: 422,
  plan_key_taken: 409,
  plan_kind_invalid: 422,
  plan_name_invalid: 422,
  plan_description_invalid: 422,
  plan_sort_invalid: 422,
  plan_price_invalid: 422,
  plan_price_not_allowed: 422,
  popular_requires_paid_plan: 422,
  contact_target_required: 422,
  contact_target_invalid: 422,
  contact_target_not_allowed: 422,
  own_plan_requires_paid_plan: 422,
  model_access_requires_managed_plan: 422,
  free_plan_key_mode_fixed: 422,
  plan_key_mode_invalid: 422,
  contact_plan_has_no_versions: 422,
  plan_not_found: 404,
  free_plan_not_deletable: 409,
  plan_has_versions: 409,
  free_plan_not_archivable: 409,
  plan_archived: 409,
  plan_version_unchanged: 409,
  plan_changed: 409,
};
