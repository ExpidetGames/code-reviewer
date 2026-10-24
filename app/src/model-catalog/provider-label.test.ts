// SPDX-License-Identifier: LicenseRef-Proprietary

// #675-T01: the name of the model provider a member reads next to an entry of the catalog. It is the maker of the model,
// never the router the key goes through and never the product name.
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { providerLabelOf } from "./provider-label.ts";

describe("the provider label of a catalog entry", () => {
  // #675-T01
  it("is the name of the provider for a registry provider that serves its own models", () => {
    expect(
      providerLabelOf({ provider: "anthropic", modelId: "claude-sonnet-5-5" }),
    ).toBe("Anthropic");
  });

  // #675-T01
  it.each([
    ["anthropic/claude-sonnet-5-5", "Anthropic"],
    ["openai/gpt-5", "OpenAI"],
    ["google/gemini-3-pro", "Google"],
    ["deepseek/deepseek-v4:free", "DeepSeek"],
    ["x-ai/grok-4-fast", "xAI"],
    ["meta-llama/llama-4-maverick", "Meta"],
    ["mistralai/mistral-large", "Mistral AI"],
    ["acme-labs/deep-thinker-4", "Acme Labs"],
  ])(
    "is the maker of %s for a model that goes through OpenRouter",
    (modelId, label) => {
      expect(providerLabelOf({ provider: "openrouter", modelId })).toBe(label);
    },
  );

  // #675-T01
  it("falls back to the router when the model id names no maker", () => {
    expect(providerLabelOf({ provider: "openrouter", modelId: "auto" })).toBe(
      "OpenRouter",
    );
  });

  // #675-T01
  it("falls back to the text of an unknown provider and never says the product name", () => {
    expect(providerLabelOf({ provider: "newcloud", modelId: "m" })).toBe(
      "Newcloud",
    );
    for (const provider of ["anthropic", "openrouter", "newcloud"])
      expect(providerLabelOf({ provider, modelId: "a/b" })).not.toMatch(
        /code-review/i,
      );
  });
});
