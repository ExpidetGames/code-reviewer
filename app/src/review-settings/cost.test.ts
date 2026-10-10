// Pins down the cost guard: the estimate per review from the price table, the warning above the
// customer's limit of 0.10 USD (and only above it), models the table does not know, and that the
// table itself is sane.
import { describe, expect, it } from "vitest";
import {
  REVIEW_COST_LIMIT_USD,
  TYPICAL_COMPLETION_TOKENS,
  TYPICAL_PROMPT_TOKENS,
  estimateReviewCost,
} from "./cost.ts";
import { MODEL_PRICES, PRICING_AS_OF } from "./model-pricing.ts";

const prices = {
  "test/cheap": {
    inputPerMillion: 1,
    outputPerMillion: 2,
    contextTokens: 100_000,
  },
  // Exactly 0.10 USD for a typical review (see the test that uses it).
  "test/limit": {
    inputPerMillion: 2,
    outputPerMillion: 13.333333333333334,
    contextTokens: 100_000,
  },
  "test/dear": {
    inputPerMillion: 5,
    outputPerMillion: 30,
    contextTokens: 100_000,
  },
};

describe("estimating the cost of a review", () => {
  // Cost guard (a decision of the project lead, no Jira test case): the price times a typical review
  it("is the price of the typical prompt and reply", () => {
    const guard = estimateReviewCost(
      { model: "test/cheap", fallbackModel: null, maxTokens: 100_000 },
      prices,
    );

    // 30000 * 1/1e6 + 3000 * 2/1e6
    expect(guard.primary).toEqual({
      status: "estimated",
      model: "test/cheap",
      usd: 0.036,
      aboveLimit: false,
    });
    expect(guard.fallback).toBeNull();
    expect(guard.warn).toBe(false);
    expect(guard.limitUsd).toBe(REVIEW_COST_LIMIT_USD);
  });

  it("never counts more prompt than the token budget allows", () => {
    const small = estimateReviewCost(
      { model: "test/cheap", fallbackModel: null, maxTokens: 10_000 },
      prices,
    );

    // 10000 * 1/1e6 + 3000 * 2/1e6
    expect(small.primary).toMatchObject({ usd: 0.016 });
    expect(TYPICAL_PROMPT_TOKENS).toBeGreaterThan(10_000);
    expect(TYPICAL_COMPLETION_TOKENS).toBe(3_000);
  });

  it("warns above 0.10 USD and not at exactly 0.10 USD", () => {
    const atLimit = estimateReviewCost(
      { model: "test/limit", fallbackModel: null, maxTokens: 100_000 },
      prices,
    );
    const above = estimateReviewCost(
      { model: "test/dear", fallbackModel: null, maxTokens: 100_000 },
      prices,
    );

    // 30000 * 2/1e6 + 3000 * 13.33.../1e6 = 0.06 + 0.04 = 0.10
    expect(atLimit.primary).toMatchObject({ usd: 0.1, aboveLimit: false });
    expect(atLimit.warn).toBe(false);
    // 30000 * 5/1e6 + 3000 * 30/1e6 = 0.15 + 0.09
    expect(above.primary).toMatchObject({ usd: 0.24, aboveLimit: true });
    expect(above.warn).toBe(true);
  });

  it("warns when only the fallback model is above the limit, and says which one", () => {
    const guard = estimateReviewCost(
      {
        model: "test/cheap",
        fallbackModel: "test/dear",
        maxTokens: 100_000,
      },
      prices,
    );

    expect(guard.warn).toBe(true);
    expect(guard.primary).toMatchObject({ aboveLimit: false });
    expect(guard.fallback).toMatchObject({
      model: "test/dear",
      aboveLimit: true,
    });
  });

  it("says 'unknown model' for a model that is not in the table, and does not warn about it", () => {
    const guard = estimateReviewCost(
      { model: "some/new-model", fallbackModel: null, maxTokens: 100_000 },
      prices,
    );

    expect(guard.primary).toEqual({
      status: "unknown_model",
      model: "some/new-model",
    });
    expect(guard.warn).toBe(false);
  });

  it("does not take a name like 'constructor' for a known model", () => {
    const guard = estimateReviewCost(
      { model: "constructor", fallbackModel: null, maxTokens: 100_000 },
      prices,
    );

    expect(guard.primary.status).toBe("unknown_model");
  });
});

describe("the price table", () => {
  it("knows the default model and stays below the limit with it", () => {
    const guard = estimateReviewCost({
      model: "deepseek/deepseek-v3.2",
      fallbackModel: null,
      maxTokens: 100_000,
    });

    expect(guard.primary.status).toBe("estimated");
    expect(guard.warn).toBe(false);
  });

  it("flags the expensive models and passes the cheap ones", () => {
    const warns = (model: string) =>
      estimateReviewCost({ model, fallbackModel: null, maxTokens: 100_000 })
        .warn;

    expect(warns("anthropic/claude-opus-5.5")).toBe(true);
    expect(warns("openai/gpt-5.5")).toBe(true);
    expect(warns("anthropic/claude-sonnet-5.5")).toBe(false);
    expect(warns("google/gemini-3.8-flash")).toBe(false);
    expect(warns("openai/gpt-5.4-mini")).toBe(false);
  });

  it("holds only positive prices and context windows, and names the day it was read", () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      expect(model, model).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
      expect(price.inputPerMillion, model).toBeGreaterThan(0);
      expect(price.outputPerMillion, model).toBeGreaterThan(0);
      expect(price.contextTokens, model).toBeGreaterThan(8_000);
    }
  });
});
