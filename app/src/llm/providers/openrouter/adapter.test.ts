// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { llmProviderAdapters } from "../server.ts";
import { MODEL_PRICES, PRICING_AS_OF } from "./model-pricing.ts";

const adapter = llmProviderAdapters.get("openrouter");

describe("the OpenRouter adapter", () => {
  // #423-T01
  it("names the provider, its API and how it reports cost", () => {
    expect(adapter.label).toBe("OpenRouter");
    expect(adapter.apiBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(adapter.costReporting).toBe("provider_reported");
  });

  // #423-T01
  it("keeps the default models the app had before the registry", () => {
    expect(adapter.defaultModels).toEqual({
      diff: "anthropic/claude-haiku-5.5",
      dynamic: "deepseek/deepseek-v4.1-flash",
    });
    expect(adapter.checkModelId(adapter.defaultModels.diff)).toBe(true);
    expect(adapter.checkModelId(adapter.defaultModels.dynamic)).toBe(true);
  });

  // #423-T01
  it("accepts a model id the way the settings always did and refuses the rest", () => {
    for (const id of [
      "anthropic/claude-haiku-5.5",
      "vendor/model:free",
      "a",
      "gpt-4o",
      `a${"b".repeat(199)}`,
    ])
      expect(adapter.checkModelId(id), id).toBe(true);
    // Upper case is valid in the first character and in the rest of the id.
    for (const id of ["Qwen/Qwen3-32B", "Vendor/Model-A", "Model", "a/B"])
      expect(adapter.checkModelId(id), id).toBe(true);
    for (const id of [
      "",
      " vendor/model",
      "vendor/model ",
      "vendor model",
      "-vendor/model",
      "vendor/mo\ndel",
      "vendor/mödel",
      `a${"b".repeat(200)}`,
    ])
      expect(adapter.checkModelId(id), id).toBe(false);
  });

  // #423-T01
  it("suggests exactly the models of its price table and prices only those", () => {
    expect([...adapter.suggestedModels]).toEqual(Object.keys(MODEL_PRICES));
    expect(adapter.suggestedModels).toContain(adapter.defaultModels.diff);
    expect(adapter.suggestedModels).toContain(adapter.defaultModels.dynamic);
    for (const model of adapter.suggestedModels)
      expect(adapter.priceOf(model), model).toBe(MODEL_PRICES[model]);
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // #423-T01
  it("has no price for a model it does not know, whatever the name is", () => {
    for (const model of [
      "vendor/unlisted",
      "constructor",
      "__proto__",
      "toString",
      "",
    ])
      expect(adapter.priceOf(model), model).toBeNull();
  });
});
