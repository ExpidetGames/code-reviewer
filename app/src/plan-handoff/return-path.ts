// SPDX-License-Identifier: LicenseRef-Proprietary

// Where people land in this app: the refusal notice links here, and the operator's page sends the person back here
// after the handover (`HandoffRedeemResponse` in contracts/operator-api.v1.json). It is a fixed path built from the
// workspace slug and nothing of a request, so neither direction has an open redirect.
//
// The target is the Plan page of the workspace settings (`/w/<slug>/settings/plan`, #282). The one constant
// `PLAN_RETURN_PATH_SECTION` decides it, for the refusal notice link and, with the description in the contract, for
// the operator's page; the settings navigation links to the same address, and tests keep the three in agreement.

/** The part after `/w/<slug>/settings`: the Plan page. */
export const PLAN_RETURN_PATH_SECTION = "/plan";

/** The path of the page the notice and the operator's page lead to, for a workspace. */
export function planReturnPath(workspaceSlug: string): string {
  return `/w/${encodeURIComponent(workspaceSlug)}/settings${PLAN_RETURN_PATH_SECTION}`;
}
