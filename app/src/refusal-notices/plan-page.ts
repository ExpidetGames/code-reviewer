// SPDX-License-Identifier: Apache-2.0

// Where the notice sends the Owners and Admins of a workspace: the plan page of the workspace in this app
// (`/w/<slug>/settings/plan`, #282). Only the address is made here. WHETHER the notice carries a link is the
// instance's decision (`planPageUrl` of the notice service, plan-link.ts): the link is in the notice exactly while the
// instance has an operator-configured plan management page (#284).

/** The path of the plan page of a workspace inside this app. */
export function planPagePath(workspaceSlug: string): string {
  return `/w/${encodeURIComponent(workspaceSlug)}/settings/plan`;
}

/** The address of the plan page of a workspace; `baseUrl` is the configured address of the app, never a request header. */
export function planPageUrl(baseUrl: string, workspaceSlug: string): string {
  return new URL(planPagePath(workspaceSlug), baseUrl).toString();
}
