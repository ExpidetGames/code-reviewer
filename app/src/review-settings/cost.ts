// SPDX-License-Identifier: Apache-2.0

// The cost guard: what a review is expected to cost with a model, and whether that is above the
// limit the customer set. It only advises (the UI shows a warning); it never blocks a setting.
//
// The estimate is deliberately simple: the price of the model (`model-pricing.ts`) times a typical
// review. A typical review sends `TYPICAL_PROMPT_TOKENS` to the model and gets
// `TYPICAL_COMPLETION_TOKENS` back, in one call. That is the size of a large pull request: the model
// comparison (three sample pull requests, prompts of 3k, 8k to 12k and 31k to 45k tokens, replies of
// 0.5k to 4k tokens) cost most for the large one, and with these two numbers the estimate for
// gemini-3.8-flash is 0.034 USD against 0.035 measured on average. The prompt is capped by the token
// budget (a review never sends more) and multiplied by the model's `inputTokenFactor` (a Claude model
// counts the same diff as 1.4 times the tokens PR-Agent does). So Claude Sonnet 5.5 is estimated at
// 0.114 USD, above the limit, which matches the one measured large review (0.1004 USD); Claude Haiku
// 5.5 at 0.006 USD against 0.0051 measured.
//
// `upperUsd` is what the review can cost at most with the model: the whole budget as the prompt, and
// as many calls as the chunking of large pull requests allows. It is shown, never used to warn.
import { MODEL_PRICES, type ModelPrice } from "./model-pricing.ts";
import type { ReviewSettings } from "./settings.ts";

/** The customer's limit: at most this many USD per review on average. Above it the UI warns. */
export const REVIEW_COST_LIMIT_USD = 0.1;
export const TYPICAL_PROMPT_TOKENS = 30_000;
export const TYPICAL_COMPLETION_TOKENS = 3_000;
/** PR-Agent's `max_number_of_calls` for chunked reviews. */
export const MAX_CHUNK_CALLS = 3;
/** The most a model may answer in one call, for the upper bound. */
export const UPPER_COMPLETION_TOKENS = 8_000;

export type CostSettings = Pick<
  ReviewSettings,
  "model" | "fallbackModel" | "maxTokens" | "largePrChunking"
>;

export type ModelCostEstimate =
  | {
      status: "estimated";
      model: string;
      /** USD for one typical review, rounded to a millionth of a dollar. */
      usd: number;
      /** USD at most (the whole budget as the prompt, every chunk call), see the top of this file. */
      upperUsd: number;
      /** True exactly when `usd` is above the limit. */
      aboveLimit: boolean;
    }
  /** The price table does not know the model: nothing can be said about its cost. */
  | { status: "unknown_model"; model: string };

export type CostWarning = {
  /** Which of the two models the warning is about. */
  model: "primary" | "fallback";
  /** `above_limit`: estimated above the limit. `cost_unknown`: the price table does not know the model. */
  kind: "above_limit" | "cost_unknown";
};

export type ReviewCostGuard = {
  limitUsd: number;
  primary: ModelCostEstimate;
  /** The fallback model's estimate, or null without a fallback model. */
  fallback: ModelCostEstimate | null;
  /** Everything worth a warning in the UI; empty when the estimate is below the limit. */
  warnings: CostWarning[];
  /** True when there is any warning. */
  warn: boolean;
  /**
   * The models whose context window is smaller than the token budget (the provider would refuse the
   * request). Only models the price table knows can be listed.
   */
  exceedsContext: Array<"primary" | "fallback">;
};

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function priceOf(
  model: string,
  prices: Readonly<Record<string, ModelPrice>>,
): ModelPrice | undefined {
  return Object.hasOwn(prices, model) ? prices[model] : undefined;
}

function estimate(
  model: string,
  settings: CostSettings,
  prices: Readonly<Record<string, ModelPrice>>,
): ModelCostEstimate {
  const price = priceOf(model, prices);
  if (price === undefined) return { status: "unknown_model", model };
  const cost = (promptTokens: number, completionTokens: number) =>
    (promptTokens * price.inputPerMillion +
      completionTokens * price.outputPerMillion) /
    1_000_000;
  const typicalPrompt =
    Math.min(TYPICAL_PROMPT_TOKENS, settings.maxTokens) *
    price.inputTokenFactor;
  const usd = roundUsd(cost(typicalPrompt, TYPICAL_COMPLETION_TOKENS));
  const calls = settings.largePrChunking ? MAX_CHUNK_CALLS : 1;
  const upperUsd = roundUsd(
    calls *
      cost(
        settings.maxTokens * price.inputTokenFactor,
        UPPER_COMPLETION_TOKENS,
      ),
  );
  return {
    status: "estimated",
    model,
    usd,
    upperUsd,
    aboveLimit: usd > REVIEW_COST_LIMIT_USD,
  };
}

/**
 * Which of the two models (`model`, `fallbackModel`) have a context window, in the table, smaller
 * than the token budget (counted in the model's own tokens). A model the table does not know is
 * never listed.
 */
export function modelsExceedingContext(
  settings: Pick<ReviewSettings, "model" | "fallbackModel" | "maxTokens">,
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): Array<"model" | "fallbackModel"> {
  const exceeds = (model: string | null): boolean => {
    if (model === null) return false;
    const price = priceOf(model, prices);
    return (
      price !== undefined &&
      settings.maxTokens * price.inputTokenFactor > price.contextTokens
    );
  };
  const result: Array<"model" | "fallbackModel"> = [];
  if (exceeds(settings.model)) result.push("model");
  if (exceeds(settings.fallbackModel)) result.push("fallbackModel");
  return result;
}

export function estimateReviewCost(
  settings: CostSettings,
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): ReviewCostGuard {
  const primary = estimate(settings.model, settings, prices);
  const fallback =
    settings.fallbackModel === null
      ? null
      : estimate(settings.fallbackModel, settings, prices);
  const warnings: CostWarning[] = [];
  for (const [which, entry] of [
    ["primary", primary],
    ["fallback", fallback],
  ] as const) {
    if (entry === null) continue;
    if (entry.status === "unknown_model")
      warnings.push({ model: which, kind: "cost_unknown" });
    else if (entry.aboveLimit)
      warnings.push({ model: which, kind: "above_limit" });
  }
  return {
    limitUsd: REVIEW_COST_LIMIT_USD,
    primary,
    fallback,
    warnings,
    warn: warnings.length > 0,
    exceedsContext: modelsExceedingContext(settings, prices).map((field) =>
      field === "model" ? "primary" : "fallback",
    ),
  };
}
