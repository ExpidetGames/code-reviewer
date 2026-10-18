// SPDX-License-Identifier: Apache-2.0

// What the admin is told before billing is switched on (ADR 0005, M18, M19): the Free plan is managed, so the own
// key of a workspace is not used any more unless the workspace buys an `own` plan, and how many workspaces that is.
// It also says what happens to a default entitlements setting of the operator (#438): enabling replaces it, and
// switching off does not bring it back. A self-hoster who never switches billing on never sees it. One owner for the
// wording (#169); the page shows it.
import "server-only";

export type EnablingFacts = {
  /** Workspaces with a stored own key and no entitlements row of the operator. */
  ownKeyWorkspaces: number;
};

/** The paragraphs of the notice, in the order the page shows them. */
export function enablingNotice({ ownKeyWorkspaces }: EnablingFacts): string[] {
  const affected =
    ownKeyWorkspaces === 0
      ? "No workspace of this instance holds a stored own key without an entitlements row of yours, so no workspace is affected today."
      : `${String(ownKeyWorkspaces)} ${ownKeyWorkspaces === 1 ? "workspace holds" : "workspaces hold"} a stored own key and ${ownKeyWorkspaces === 1 ? "has" : "have"} no entitlements row of yours, so ${ownKeyWorkspaces === 1 ? "it is" : "they are"} affected.`;
  return [
    "Workspaces without a subscription fall onto the Free plan. The Free plan is managed: it reviews with your key and the models you release, within its limits.",
    "The own key of a workspace is then not used. A workspace that holds a stored own key ends its jobs with own_key_requires_plan until it buys an own plan or deletes the key. Create an own plan before you switch billing on, or these workspaces have nothing to buy.",
    affected,
    "Billing also takes over the default entitlements of the instance. A default entitlements setting that you already set through the operator API is replaced by the Free plan, and it is not restored: switching billing off again removes the default that billing wrote, so the instance then has no default (workspaces without an entitlements row are unlimited) instead of your earlier one. Note it down first if you want to set it again.",
  ];
}
