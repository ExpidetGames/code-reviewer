// SPDX-License-Identifier: Apache-2.0

// Whose key the reviews of a workspace run on, for the line of the billing page that points to the LLM access page (#505). It
// reads the summary the LLM access gives (`WorkspaceLlmSummary`), so the page never decides a key mode of its own: the choice
// is made on the LLM access page (#496). A workspace whose entitlements cannot be read has no known mode.
import "server-only";
import type { WorkspaceLlmSummary } from "../llm/assemble.ts";
import type { WorkspaceKeyMode } from "../workspace-billing/view.ts";

export function workspaceKeyModeOf(
  summary: WorkspaceLlmSummary,
): WorkspaceKeyMode {
  if (summary.configured) return summary.source === "operator" ? "managed" : "own";
  switch (summary.reason) {
    case "operator_key_missing":
    case "operator_key_unreadable":
      return "managed";
    case "entitlements_invalid":
      return "none";
    case "no_key":
    case "key_unreadable":
    case "key_binding_mismatch":
      return "own";
  }
}
