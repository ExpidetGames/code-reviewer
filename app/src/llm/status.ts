// SPDX-License-Identifier: LicenseRef-Proprietary

// What the UI may know about the instance's LLM defaults: the built-in model and the options of
// `LLM_MODEL` and `LLM_MAX_TOKENS`, and a warning for an option that is ignored. Never a value.
// The key is a matter of each workspace (src/llm/), so the instance has nothing to report about one.
import type { LlmConfigIssue, LlmProvider } from "./config.ts";

export type LlmStatus = {
  configured: true;
  provider: LlmProvider;
  model: string;
  /** Optional variables that were wrong and are ignored (the default is used instead). */
  warnings: readonly LlmConfigIssue[];
};
