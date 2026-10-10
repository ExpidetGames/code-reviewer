// The cost guard: what a review is expected to cost with a model, and whether that is above the
// limit the customer set. It only advises (the UI shows a warning); it never blocks a setting.
//
// The estimate is deliberately simple: the price of the model (`model-pricing.ts`) times a typical
// review. A typical review sends `TYPICAL_PROMPT_TOKENS` to the model and gets
// `TYPICAL_COMPLETION_TOKENS` back, in one call. The numbers come from the model comparison runs
// (three sample pull requests, prompts of 3k, 8k to 12k and 31k to 45k tokens, replies of 0.5k to
// 4k tokens): with these two numbers the estimate for gemini-3.8-flash is 0.034 USD against 0.035
// measured on average, for deepseek-v3.2 0.010 against 0.007. A review never sends more than the
// token budget, so the prompt is capped by it. It does not count chunked reviews of very large pull
// requests (up to three calls), so the guard is an indication, not a bill.
import { MODEL_PRICES, type ModelPrice } from "./model-pricing.ts";
import type { ReviewSettings } from "./settings.ts";

/** The customer's limit: at most this many USD per review on average. Above it the UI warns. */
export const REVIEW_COST_LIMIT_USD = 0.1;
export const TYPICAL_PROMPT_TOKENS = 30_000;
export const TYPICAL_COMPLETION_TOKENS = 3_000;

export type ModelCostEstimate =
  | {
      status: "estimated";
      model: string;
      /** USD for one typical review, rounded to a millionth of a dollar. */
      usd: number;
      /** True exactly when `usd` is above the limit. */
      aboveLimit: boolean;
    }
  | { status: "unknown_model"; model: string };

export type ReviewCostGuard = {
  limitUsd: number;
  primary: ModelCostEstimate;
  /** The fallback model's estimate, or null without a fallback model. */
  fallback: ModelCostEstimate | null;
  /** True when the model or the fallback model is estimated above the limit. */
  warn: boolean;
};

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function estimate(
  model: string,
  maxTokens: number,
  prices: Readonly<Record<string, ModelPrice>>,
): ModelCostEstimate {
  const price = Object.hasOwn(prices, model) ? prices[model] : undefined;
  if (price === undefined) return { status: "unknown_model", model };
  const promptTokens = Math.min(TYPICAL_PROMPT_TOKENS, maxTokens);
  const usd = roundUsd(
    (promptTokens * price.inputPerMillion +
      TYPICAL_COMPLETION_TOKENS * price.outputPerMillion) /
      1_000_000,
  );
  return {
    status: "estimated",
    model,
    usd,
    aboveLimit: usd > REVIEW_COST_LIMIT_USD,
  };
}

export function estimateReviewCost(
  settings: Pick<ReviewSettings, "model" | "fallbackModel" | "maxTokens">,
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): ReviewCostGuard {
  const primary = estimate(settings.model, settings.maxTokens, prices);
  const fallback =
    settings.fallbackModel === null
      ? null
      : estimate(settings.fallbackModel, settings.maxTokens, prices);
  const above = (entry: ModelCostEstimate | null) =>
    entry?.status === "estimated" && entry.aboveLimit;
  return {
    limitUsd: REVIEW_COST_LIMIT_USD,
    primary,
    fallback,
    warn: above(primary) || above(fallback),
  };
}
