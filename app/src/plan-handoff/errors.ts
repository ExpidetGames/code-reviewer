// SPDX-License-Identifier: Apache-2.0

// What a refused click on "Manage plan" tells the page. The button is a plain form post, so a refusal is not read by a
// script: the browser would show the JSON. The route sends it back to the settings page instead
// (`settingsPathWithPlanError`), with one of these codes as the `plan_error` parameter, and the page translates the
// code to copy (`ui/manage-plan-card.tsx`), never the other way round. A role that may not manage the plan (a Member
// has no button) and a lost session keep the usual JSON answers of every workspace route.
import { singleSearchParam } from "../http/search-params.ts";

export const PLAN_HANDOFF_ERROR_CODES = [
  /** The request did not come from this site (`Sec-Fetch-Site` / `Origin`). */
  "cross_site_request",
  /** Too many clicks of this person in this workspace. */
  "rate_limited",
] as const;
export type PlanHandoffErrorCode = (typeof PLAN_HANDOFF_ERROR_CODES)[number];

export const PLAN_ERROR_PARAMETER = "plan_error";

/** The code in a search parameter of the settings page, or null for anything that is not one of ours. */
export function planHandoffErrorOf(
  value: string | string[] | undefined,
): PlanHandoffErrorCode | null {
  const single = singleSearchParam(value);
  return PLAN_HANDOFF_ERROR_CODES.find((code) => code === single) ?? null;
}

/** The relative path the browser is sent back to: the settings of the workspace named in the address, and the code. */
export function settingsPathWithPlanError(
  workspaceSlug: string,
  code: PlanHandoffErrorCode,
): string {
  return `/w/${encodeURIComponent(workspaceSlug)}/settings?${PLAN_ERROR_PARAMETER}=${code}`;
}
