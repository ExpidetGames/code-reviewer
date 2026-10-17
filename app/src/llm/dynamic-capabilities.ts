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
 * The most output one model call may ask for. A bigger limit the model states is not an invitation,
 * since the allowance is reserved against the run's cost limit on every call.
 */
export const DYNAMIC_OUTPUT_ALLOWANCE_TOKENS = 8192;

/**
 * The allowance of a model that is cheap enough for it (#309). A review with up to 30 findings plus
 * the reasoning tokens of a reasoning model, which count against `max_tokens`, does not fit 8192
 * tokens; a turn cut off there ends without an answer. The default model's endpoints at the provider
 * state at least 131072 completion tokens (`/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints`,
 * read on 2026-10-14; the model's top provider states 943718), so 32768 is below every limit. The
 * runner's built-in descriptor of the default model uses the same value.
 */
export const DYNAMIC_LARGE_OUTPUT_ALLOWANCE_TOKENS = 32_768;

/**
 * The highest output price (USD per million tokens) at which the large allowance is given. Every call
 * reserves its whole allowance at the output price against the cost limit (1 USD by default), and a
 * reservation of two calls (a call and the final call after it) must leave room: at this price one
 * reservation is about 0.13 USD. A dearer or unpriced model keeps the standard allowance.
 */
export const LARGE_ALLOWANCE_MAX_OUTPUT_USD_PER_MTOK = 4;

function allowanceFor(outputUsdPerMtok: string | null): number {
  if (outputUsdPerMtok === null || outputUsdPerMtok.trim() === "")
    return DYNAMIC_OUTPUT_ALLOWANCE_TOKENS;
  const price = Number(outputUsdPerMtok);
  return Number.isFinite(price) &&
    price >= 0 &&
    price <= LARGE_ALLOWANCE_MAX_OUTPUT_USD_PER_MTOK
    ? DYNAMIC_LARGE_OUTPUT_ALLOWANCE_TOKENS
    : DYNAMIC_OUTPUT_ALLOWANCE_TOKENS;
}

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
  const allowance = allowanceFor(outputUsdPerMtok);
  return {
    toolChoiceRequired: metadata.toolChoiceRequired,
    // The pinned engine returns its findings through a tool call: structured output here is tool
    // calling, not `response_format`.
    structuredOutput: metadata.tools && metadata.toolChoiceRequired,
    maxOutputTokens: Math.max(
      1,
      Math.min(
        allowance,
        metadata.smallestCompletionTokens ?? allowance,
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
