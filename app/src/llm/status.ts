// SPDX-License-Identifier: Apache-2.0

// What the UI may know about the LLM access: whether it works and, if it does not, which variables
// are wrong. Never the key, and never any value of a variable that is wrong.
import type { LlmConfigIssue, LlmConfigState, LlmProvider } from "./config.ts";

export type LlmStatus =
  | {
      configured: true;
      provider: LlmProvider;
      model: string;
      /** Optional variables that were wrong and are ignored (the default is used instead). */
      warnings: readonly LlmConfigIssue[];
    }
  | {
      configured: false;
      /** What stops reviews: the provider or the key. */
      issues: readonly LlmConfigIssue[];
      warnings: readonly LlmConfigIssue[];
    };

export function describeLlmStatus(state: LlmConfigState): LlmStatus {
  if (state.status === "configured")
    return {
      configured: true,
      provider: state.config.provider,
      model: state.config.model,
      warnings: state.warnings,
    };
  return {
    configured: false,
    issues: state.issues,
    warnings: state.warnings,
  };
}
