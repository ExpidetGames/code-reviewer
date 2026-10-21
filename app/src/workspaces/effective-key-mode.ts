// SPDX-License-Identifier: Apache-2.0

// Whose key a workspace's reviews run on (ADR 0006, P3, D4; #496). While billing is off the entitlements decide, as they always
// did: a self-hoster who never switches billing on sees no change. While billing is on the WORKSPACE decides: the entitlement's
// `keyMode` (of a row or of `default_entitlements`) is not consulted, because the Free plan and "the own key needs an own plan" are
// gone and nothing else says which key applies. What the entitlements still say while billing is on are the suspension, the
// model access and the cost limits; entitlements that cannot be read still fail closed, because it is not known whether the
// workspace is suspended. Pure: the callers read the pieces (src/workspaces/effective-entitlements.ts).
import { type KeyMode, type ResolvedEntitlements } from "./entitlements.ts";

/** The key mode of a workspace that has not chosen, while billing is on: our models. */
export const DEFAULT_LLM_KEY_MODE = "managed" as const satisfies KeyMode;

export type KeyModeFacts = {
  /** Billing is on for this moment (the switch is set and its adapter is ready). */
  billingOn: boolean;
  /** What the workspace stored; `undefined` when it has not chosen. Never read while billing is off. */
  workspaceChoice: KeyMode | undefined;
  entitlements: ResolvedEntitlements;
};

/** The key mode that applies, or `unreadable` when the entitlements cannot be read and it is not known what applies. */
export function effectiveKeyMode({
  billingOn,
  workspaceChoice,
  entitlements,
}: KeyModeFacts): KeyMode | "unreadable" {
  if (entitlements.kind === "invalid") return "unreadable";
  if (billingOn) return workspaceChoice ?? DEFAULT_LLM_KEY_MODE;
  return entitlements.kind === "unlimited" ? "own" : entitlements.keyMode;
}

/**
 * The entitlements with the key mode that applies: what every reader of a workspace's entitlements sees, so the claim's admission
 * and the choice of the LLM key cannot differ. Billing off: the entitlements as they are. Billing on: the same entitlements with
 * the workspace's choice in place of their `keyMode`; a workspace without entitlements stays unlimited and carries the choice.
 */
export function applyWorkspaceKeyMode(
  entitlements: ResolvedEntitlements,
  facts: Omit<KeyModeFacts, "entitlements">,
): ResolvedEntitlements {
  if (!facts.billingOn || entitlements.kind === "invalid") return entitlements;
  const keyMode = effectiveKeyMode({ ...facts, entitlements });
  if (keyMode === "unreadable") return entitlements;
  return entitlements.kind === "unlimited"
    ? { kind: "unlimited", keyMode }
    : { ...entitlements, keyMode };
}
