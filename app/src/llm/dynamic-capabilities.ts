// SPDX-License-Identifier: Apache-2.0

// The capability descriptor a Dynamic job carries (#279): what the provider's public model metadata
// (src/llm/model-capabilities.ts) says the job's model can do, in the shape of `DynamicModelCapabilities`
// in contracts/runner-api.v1.json. It is derived from the provider's metadata only. Nothing a repository,
// a pull request or the model itself says takes part, and nothing is invented: a window the metadata does
// not state makes no descriptor, and prices it does not state are left out (the runner then refuses to run
// the model, because a cost that cannot be priced cannot be bounded).
import type { DynamicModelCapabilities } from "../runner-api/contract.ts";
import type { ModelCapabilities } from "./model-capabilities.ts";

/**
 * The most output one model call may ask for. It is the output allowance the runner's built-in
 * descriptor of the default model already uses, and a ceiling here: a bigger limit the model states is
 * not an invitation, since the allowance is reserved against the run's cost limit on every call.
 */
export const DYNAMIC_OUTPUT_ALLOWANCE_TOKENS = 8192;

/**
 * The largest window the contract carries (`DynamicModelCapabilities.contextWindowTokens`; a test keeps
 * the two equal). A model that states more has no descriptor: the runner would refuse the whole job as
 * malformed, and no descriptor makes it use its own description instead.
 */
export const MAX_CONTEXT_WINDOW_TOKENS = 100_000_000;

/** The descriptor of a model whose metadata was read, or null when the metadata has no usable window. */
export function dynamicCapabilitiesOf(
  metadata: ModelCapabilities,
): DynamicModelCapabilities | null {
  const window = metadata.contextLength;
  if (window === null || window > MAX_CONTEXT_WINDOW_TOKENS) return null;
  const { inputUsdPerMtok, outputUsdPerMtok } = metadata;
  return {
    toolChoiceRequired: metadata.toolChoiceRequired,
    // The pinned engine returns its findings through a tool call: structured output here is tool
    // calling, not `response_format`.
    structuredOutput: metadata.tools && metadata.toolChoiceRequired,
    maxOutputTokens: Math.max(
      1,
      Math.min(
        DYNAMIC_OUTPUT_ALLOWANCE_TOKENS,
        metadata.smallestCompletionTokens ?? DYNAMIC_OUTPUT_ALLOWANCE_TOKENS,
        // A window with no room for its own output is no usable window; the runner refuses it.
        Math.floor(window / 2),
      ),
    ),
    contextWindowTokens: window,
    ...(inputUsdPerMtok !== null && outputUsdPerMtok !== null
      ? { inputUsdPerMtok, outputUsdPerMtok }
      : {}),
  };
}
