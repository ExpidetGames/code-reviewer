// SPDX-License-Identifier: Apache-2.0

// Whose key a job runs on, as far as the CLAIM can know it (#498): whether the balance can be zero depends on it (the operator's
// key costs AI plus minutes, the workspace's own key the minutes only, ADR 0006, 2.8). It is the key mode of the effective
// entitlements the claim has read anyway (`readEffectiveEntitlements`): the entitlement's while billing is off, the workspace's
// own choice while it is on (#496, `effectiveKeyMode`). It is the same answer `keyModeForJob` gives the LLM access
// (src/llm/resolve.ts), so the claim and the key a job is given cannot differ.
import "server-only";
import type {
  KeyMode,
  ResolvedEntitlements,
} from "../workspaces/entitlements.ts";

/**
 * A workspace without entitlements is unlimited on its own key unless billing is on, when the choice of the workspace travels
 * with it; unreadable entitlements never get here (the admission refuses the job first), and would be the cheaper `own` if they
 * did.
 */
export function keyModeAtClaim(entitlements: ResolvedEntitlements): KeyMode {
  if (entitlements.kind === "invalid") return "own";
  return entitlements.keyMode ?? "own";
}
