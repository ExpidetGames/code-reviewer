// SPDX-License-Identifier: LicenseRef-Proprietary

// The part of the Anthropic (Claude API, direct) adapter that is data and pure rules, safe for a client component to
// import. The models, their prices and flags are `models.ts`; everything here is derived from that list.
import type { LlmProviderDescriptor, ModelPrice } from "../types.ts";
import {
  ANTHROPIC_DEFAULT_MODELS,
  ANTHROPIC_MODELS,
  anthropicModel,
  anthropicModelIdsFor,
  isAnthropicModelId,
} from "./models.ts";

/**
 * The tokens PR-Agent counts in a prompt, as Claude counts them: the same diff is 1.4 times as many tokens for the
 * tokenizer of Claude 4.7 and later (measured in the model comparison). The older
 * tokenizer produces fewer tokens, so the factor over-estimates those models: the safe side for a guard.
 */
const INPUT_TOKEN_FACTOR = 1.4;

function priceOf(model: string): ModelPrice | null {
  const entry = anthropicModel(model);
  if (entry === undefined) return null;
  return {
    inputPerMillion: Number(entry.pricesUsdPerMTok.input),
    outputPerMillion: Number(entry.pricesUsdPerMTok.output),
    contextTokens: entry.contextWindowTokens,
    inputTokenFactor: INPUT_TOKEN_FACTOR,
  };
}

export const anthropicDescriptor = {
  id: "anthropic",
  label: "Anthropic",
  // The Claude API. Every path of the adapter is relative to this address (`/models`); the runner derives the
  // Messages endpoint from it.
  apiBaseUrl: "https://api.anthropic.com/v1",
  // The names the keys are stored under; the ciphertext is bound to them, so they never change (ADR 0005, 2.5).
  secretNames: {
    workspace: "llm_api_key.anthropic",
    operator: "operator_llm_key.anthropic",
  },
  // The list is closed: only a model of `models.ts` can be chosen, whoever brings the key.
  checkModelId: isAnthropicModelId,
  suggestedModels: ANTHROPIC_MODELS.map((model) => model.id),
  // A save and the claim refuse the models whose `reviewKinds` lack the kind, so a form must not offer those (#532).
  dynamicSuggestedModels: anthropicModelIdsFor("dynamic"),
  priceOf,
  defaultModels: ANTHROPIC_DEFAULT_MODELS,
  // Anthropic returns token counts and no charge: the runner prices every call with the list's prices.
  costReporting: "computed_from_usage",
} as const satisfies LlmProviderDescriptor;
