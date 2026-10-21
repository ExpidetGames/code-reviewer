// SPDX-License-Identifier: Apache-2.0

// Whose key a job runs on, as far as the CLAIM can know it (#498): the hold depends on it (the operator's key holds AI plus
// minutes, the workspace's own key the minutes only, ADR 0006, 2.8). Today it is the key mode of the entitlements the claim
// has read anyway, the same answer `keyModeForJob` gives the LLM access (src/llm/resolve.ts), so the hold and the key a job
// is given cannot differ.
//
// This file is the seam of #496: while billing is on, the key mode is the workspace's own choice (`effectiveKeyMode`),
// and this function becomes that call. Nothing else in the claim needs to change.
import "server-only";
import type {
  KeyMode,
  ResolvedEntitlements,
} from "../workspaces/entitlements.ts";

/**
 * A workspace without entitlements is unlimited on its own key; unreadable entitlements never get here (the admission
 * refuses the job first), and would hold the cheaper `own` if they did.
 */
export function keyModeAtClaim(entitlements: ResolvedEntitlements): KeyMode {
  return entitlements.kind === "limited" ? entitlements.keyMode : "own";
}
