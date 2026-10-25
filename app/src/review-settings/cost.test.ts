// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the cost guard: the estimate per review from the price table (with the tokenizer factor of
// Claude models), the warning above the customer's limit of 0.10 USD (and only above it), the warning
// for a model the table does not know, the upper bound, the context window check, and that the table
// itself is sane and holds the prices of the model comparison.
import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_MODEL } from "../llm/config.ts";
import { DEFAULT_REVIEW_TOKEN_BUDGET } from "../model-catalog/token-budget.ts";
import {
  REVIEW_COST_LIMIT_USD,
  TYPICAL_COMPLETION_TOKENS,
  TYPICAL_PROMPT_TOKENS,
  estimateReviewCost,
  type CostSettings,
} from "./cost.ts";
import {
  MODEL_PRICES,
  PRICING_AS_OF,
} from "../llm/providers/openrouter/model-pricing.ts";
import { createFakeAdapter } from "../llm/providers/fake-adapter.ts";
import { openrouterDescriptor } from "../llm/providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "../llm/providers/registry.ts";

const prices = {
  "test/cheap": {
    inputPerMillion: 1,
    outputPerMillion: 2,
    contextTokens: 100_000,
    inputTokenFactor: 1,
  },
  // Exactly 0.10 USD for a typical review: 30000 * 2 / 1e6 + 3000 * 13.33.. / 1e6 = 0.06 + 0.04.
  "test/limit": {
    inputPerMillion: 2,
    outputPerMillion: 13.333333333333334,
    contextTokens: 100_000,
    inputTokenFactor: 1,
  },
  "test/dear": {
    inputPerMillion: 5,
    outputPerMillion: 30,
    contextTokens: 100_000,
    inputTokenFactor: 1,
  },
  "test/wordy": {
    inputPerMillion: 1,
    outputPerMillion: 1,
    contextTokens: 400_000,
    inputTokenFactor: 1.5,
  },
};

const settings = (changes: Partial<CostSettings>): CostSettings => ({
  model: "test/cheap",
  fallbackModel: null,
  largePrChunking: false,
  ...changes,
});

// #656-T04
describe("the limit the customer set", () => {
  it("replaces the default limit of the estimate, and a model above it warns", () => {
    const guard = estimateReviewCost(
      settings({ model: "test/cheap", maxCostCents: 3 }),
      prices,
    );

    // 0.036 USD for a typical review against a limit of 0.03 USD
    expect(guard.limitUsd).toBe(0.03);
    expect(guard.primary).toMatchObject({ usd: 0.036, aboveLimit: true });
    expect(guard.warnings).toEqual([{ model: "primary", kind: "above_limit" }]);
  });

  it("raises the limit above the default one, and a null limit leaves the default", () => {
    const raised = estimateReviewCost(
      settings({ model: "test/dear", maxCostCents: 500 }),
      prices,
    );
    const none = estimateReviewCost(
      settings({ model: "test/dear", maxCostCents: null }),
      prices,
    );

    expect(raised.limitUsd).toBe(5);
    expect(raised.warn).toBe(false);
    expect(none.limitUsd).toBe(REVIEW_COST_LIMIT_USD);
    expect(none.warn).toBe(true);
    // #666: only a limit the customer set is enforced; the standard level only warns.
    expect(raised.customLimit).toBe(true);
    expect(none.customLimit).toBe(false);
  });
});

describe("estimating the cost of a review", () => {
  // Cost guard (a decision of the project lead, no Jira test case): the price times a typical review
  it("is the price of the typical prompt and reply", () => {
    const guard = estimateReviewCost(settings({}), prices);

    // 30000 * 1/1e6 + 3000 * 2/1e6
    expect(guard.primary).toMatchObject({
      status: "estimated",
      model: "test/cheap",
      usd: 0.036,
      aboveLimit: false,
    });
    expect(guard.fallback).toBeNull();
    expect(guard.warnings).toEqual([]);
    expect(guard.warn).toBe(false);
    expect(guard.limitUsd).toBe(REVIEW_COST_LIMIT_USD);
  });

  it("counts the prompt in the model's own tokens", () => {
    const guard = estimateReviewCost(settings({ model: "test/wordy" }), prices);

    // 30000 * 1.5 * 1/1e6 + 3000 * 1/1e6
    expect(guard.primary).toMatchObject({ usd: 0.048 });
  });

  // #689-T02
  it("never counts more prompt than the token budget the app uses allows", () => {
    // The typical review is below the internal budget, so it is the typical number that counts.
    expect(TYPICAL_PROMPT_TOKENS).toBeLessThan(DEFAULT_REVIEW_TOKEN_BUDGET);
    expect(TYPICAL_COMPLETION_TOKENS).toBe(3_000);
  });

  it("warns above 0.10 USD and not at exactly 0.10 USD", () => {
    const atLimit = estimateReviewCost(
      settings({ model: "test/limit" }),
      prices,
    );
    const above = estimateReviewCost(settings({ model: "test/dear" }), prices);

    expect(atLimit.primary).toMatchObject({ usd: 0.1, aboveLimit: false });
    expect(atLimit.warn).toBe(false);
    // 30000 * 5/1e6 + 3000 * 30/1e6 = 0.15 + 0.09
    expect(above.primary).toMatchObject({ usd: 0.24, aboveLimit: true });
    expect(above.warnings).toEqual([{ model: "primary", kind: "above_limit" }]);
    expect(above.warn).toBe(true);
  });

  it("warns when only the fallback model is above the limit, and says which one", () => {
    const guard = estimateReviewCost(
      settings({ fallbackModel: "test/dear" }),
      prices,
    );

    expect(guard.warn).toBe(true);
    expect(guard.primary).toMatchObject({ aboveLimit: false });
    expect(guard.fallback).toMatchObject({
      model: "test/dear",
      aboveLimit: true,
    });
    expect(guard.warnings).toEqual([
      { model: "fallback", kind: "above_limit" },
    ]);
  });

  it("warns that the cost is unknown for a model that is not in the table", () => {
    const guard = estimateReviewCost(
      settings({ model: "some/new-model", fallbackModel: "other/unlisted" }),
      prices,
    );

    expect(guard.primary).toEqual({
      status: "unknown_model",
      model: "some/new-model",
    });
    expect(guard.warnings).toEqual([
      { model: "primary", kind: "cost_unknown" },
      { model: "fallback", kind: "cost_unknown" },
    ]);
    expect(guard.warn).toBe(true);
  });

  it("does not take a name like 'constructor' for a known model", () => {
    const guard = estimateReviewCost(
      settings({ model: "constructor" }),
      prices,
    );

    expect(guard.primary.status).toBe("unknown_model");
  });

  it("gives an upper bound: the whole budget as the prompt, for every call chunking allows", () => {
    const plain = estimateReviewCost(settings({}), prices);
    const chunked = estimateReviewCost(
      settings({ largePrChunking: true }),
      prices,
    );

    // 100000 * 1/1e6 + 8000 * 2/1e6 = 0.116 per call, 1 or 3 calls
    expect(plain.primary).toMatchObject({ upperUsd: 0.116 });
    expect(chunked.primary).toMatchObject({ upperUsd: 0.348 });
    // The upper bound is shown, it does not warn: the typical estimate does.
    expect(chunked.warn).toBe(false);
  });
});

// #689-T02: the token budget is no setting and the cost guard no longer checks it against the context window.
describe("the cost guard without a token budget", () => {
  it("has no list of models whose window is too small", () => {
    const guard = estimateReviewCost(
      settings({ fallbackModel: "test/limit" }),
      prices,
    );

    expect(Object.keys(guard)).not.toContain("exceedsContext");
  });
});

describe("the price table", () => {
  it("knows the default model and stays far below the limit with it", () => {
    const guard = estimateReviewCost({
      model: DEFAULT_LLM_MODEL,
      fallbackModel: null,
      largePrChunking: true,
    });

    expect(DEFAULT_LLM_MODEL).toBe("anthropic/claude-haiku-5.5");
    // 30000 * 1.4 * 0.1/1e6 + 3000 * 0.5/1e6
    expect(guard.primary).toMatchObject({ status: "estimated", usd: 0.0057 });
    expect(guard.warn).toBe(false);
  });

  it("flags Claude Sonnet 5.5, the expensive models and the unlisted ones, and passes the cheap ones", () => {
    const warns = (model: string) =>
      estimateReviewCost({
        model,
        fallbackModel: null,
        largePrChunking: true,
      }).warn;

    // 30000 * 1.4 * 2/1e6 + 3000 * 10/1e6 = 0.084 + 0.03 = 0.114 (measured: 0.1004 for the large review)
    expect(warns("anthropic/claude-sonnet-5.5")).toBe(true);
    expect(warns("anthropic/claude-opus-5.5")).toBe(true);
    expect(warns("openai/gpt-5.5")).toBe(true);
    expect(warns("some/unlisted-model")).toBe(true);
    expect(warns("anthropic/claude-haiku-5.5")).toBe(false);
    expect(warns("google/gemini-3.8-flash")).toBe(false);
    expect(warns("openai/gpt-5.4-mini")).toBe(false);
    expect(warns("deepseek/deepseek-v3.2")).toBe(false);
  });

  it("holds the prices of the model comparison and the tokenizer factor of the Claude models", () => {
    const expected: Record<string, [number, number, number]> = {
      "deepseek/deepseek-v3.2": [0.259, 0.8, 1],
      "google/gemini-3.8-flash": [0.75, 3.75, 1],
      "openai/gpt-5.4-mini": [0.75, 4.5, 1],
      "anthropic/claude-sonnet-5.5": [2, 10, 1.4],
      "anthropic/claude-haiku-5.5": [0.1, 0.5, 1.4],
    };

    for (const [model, [input, output, factor]] of Object.entries(expected))
      expect(MODEL_PRICES[model], model).toMatchObject({
        inputPerMillion: input,
        outputPerMillion: output,
        inputTokenFactor: factor,
      });
  });

  it("holds only positive prices, context windows and factors, and names the day it was read", () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      expect(model, model).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
      expect(price.inputPerMillion, model).toBeGreaterThan(0);
      expect(price.outputPerMillion, model).toBeGreaterThan(0);
      expect(price.contextTokens, model).toBeGreaterThan(100_000);
      expect(price.inputTokenFactor, model).toBeGreaterThanOrEqual(1);
      if (model.startsWith("anthropic/"))
        expect(price.inputTokenFactor, model).toBe(1.4);
    }
  });
});

// #433-T01
describe("the estimate follows the provider of the settings", () => {
  const registry = createProviderRegistry([
    openrouterDescriptor,
    createFakeAdapter(),
  ]);
  const settings = (provider: string, model: string) => ({
    provider,
    model,
    fallbackModel: null,
    largePrChunking: true,
  });

  it("prices a model with the price table of the chosen provider, not of the default one", () => {
    const guard = estimateReviewCost(
      settings("fakeai", "fake-small"),
      undefined,
      registry,
    );

    expect(guard.primary.status).toBe("estimated");
  });

  it("does not know a model of another provider", () => {
    const guard = estimateReviewCost(
      settings("openrouter", "fake-small"),
      undefined,
      registry,
    );

    expect(guard.primary.status).toBe("unknown_model");
  });

  it("uses the default provider for settings that name none", () => {
    const guard = estimateReviewCost(
      { ...settings("openrouter", DEFAULT_LLM_MODEL), provider: undefined },
      undefined,
      registry,
    );

    expect(guard.primary.status).toBe("estimated");
  });
});
