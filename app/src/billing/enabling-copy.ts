// SPDX-License-Identifier: LicenseRef-Proprietary

// What the admin is told before billing is switched on (ADR 0006, 2.14; #504): every workspace is charged from a prepaid
// balance, the workspaces choose their key mode, one without balance cannot start a review, the run quotas are not applied and
// the operator API limits stay; and how many workspaces the instance has and how many hold a stored own key. A self-hoster who
// never switches billing on never sees it anywhere but on this page. One owner for the wording (#169); the page shows it.
import "server-only";

export type EnablingFacts = {
  /** All workspaces of the instance. */
  workspaces: number;
  /** Of them, those that hold a stored own LLM key. */
  ownKeyWorkspaces: number;
};

function workspacesText(count: number): string {
  if (count === 0) return "no workspace";
  return `${String(count)} ${count === 1 ? "workspace" : "workspaces"}`;
}

function ownKeyText(workspaces: number, ownKeyWorkspaces: number): string {
  if (workspaces === 0)
    return "There is no workspace that holds a stored own key.";
  if (ownKeyWorkspaces === 0) return "None of them holds a stored own key.";
  if (workspaces === 1) return "It holds a stored own key.";
  return `${String(ownKeyWorkspaces)} of them ${ownKeyWorkspaces === 1 ? "holds" : "hold"} a stored own key.`;
}

/** The paragraphs of the notice, in the order the page shows them. */
export function enablingNotice({
  workspaces,
  ownKeyWorkspaces,
}: EnablingFacts): string[] {
  return [
    "Once billing is on, the reviews of every workspace on this instance are charged from a prepaid balance in US dollars. A review costs its infrastructure minutes, plus the AI cost when it runs on your models.",
    "Each workspace chooses its key mode: your models (the default) or its own key. A review on its own key is charged for its minutes only.",
    "A workspace with no balance cannot start a review until it has the start credit or credit from a top-up or from you.",
    "The run quotas of the workspaces are not applied while billing is on. The operator API limits stay.",
    `This instance has ${workspacesText(workspaces)}. ${ownKeyText(workspaces, ownKeyWorkspaces)}`,
  ];
}
