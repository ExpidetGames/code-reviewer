// SPDX-License-Identifier: Apache-2.0

// Where people land in this app: the refusal notice links here, and the operator's page sends the person back here
// after the handover (`HandoffRedeemResponse` in contracts/operator-api.v1.json). It is a fixed path built from the
// workspace slug and nothing of a request, so neither direction has an open redirect.
//
// TODO(#282): until the plan page of #282 exists, the target is the General settings page of the workspace
// (`/w/<slug>/settings`), which already has the "Manage plan" card. When #282 lands, set
// `PLAN_RETURN_PATH_SECTION` to "/plan" (and the contract description, which names the same path): this is the one
// place that decides it. Do not let a release reach `main` with a target that does not exist.

/** The part after `/w/<slug>/settings`: empty while the General settings page is the target, "/plan" with #282. */
export const PLAN_RETURN_PATH_SECTION = "";

/** The path of the page the notice and the operator's page lead to, for a workspace. */
export function planReturnPath(workspaceSlug: string): string {
  return `/w/${encodeURIComponent(workspaceSlug)}/settings${PLAN_RETURN_PATH_SECTION}`;
}
