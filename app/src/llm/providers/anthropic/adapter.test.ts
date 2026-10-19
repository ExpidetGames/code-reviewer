// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { dynamicCapabilitiesOf } from "../../dynamic-capabilities.ts";
import { llmProviderAdapters } from "../server.ts";
import { ANTHROPIC_MODELS } from "./models.ts";

const adapter = llmProviderAdapters.get("anthropic");

describe("the Anthropic adapter", () => {
  // #511-T07
  it("names the provider, its API and how it reports cost", () => {
    expect(adapter.label).toBe("Anthropic");
    expect(adapter.apiBaseUrl).toBe("https://api.anthropic.com/v1");
    expect(adapter.costReporting).toBe("computed_from_usage");
  });

  // #511-T07
  it("stores its keys under names of its own, next to the first provider's", () => {
    expect(adapter.secretNames).toEqual({
      workspace: "llm_api_key.anthropic",
      operator: "operator_llm_key.anthropic",
    });
    const other = llmProviderAdapters.get("openrouter").secretNames;
    expect(other.workspace).not.toBe(adapter.secretNames.workspace);
    expect(other.operator).not.toBe(adapter.secretNames.operator);
  });

  // #511-T04
  it("accepts the listed models only, in the exact spelling of the API", () => {
    for (const model of ANTHROPIC_MODELS)
      expect(adapter.checkModelId(model.id), model.id).toBe(true);
    for (const id of [
      "anthropic/claude-haiku-5-5",
      "claude-haiku-5.5",
      "claude-sonnet-4-5-20250929",
      "gpt-5",
      "",
    ])
      expect(adapter.checkModelId(id), id).toBe(false);
    expect([...adapter.suggestedModels]).toEqual(
      ANTHROPIC_MODELS.map((model) => model.id),
    );
  });

  // #511-T01
  // #533-T16: the Dynamic default moved from Sonnet 5 to Sonnet 5.5 when the runner learned to steer it.
  it("keeps the defaults of the decision: Haiku 5.5 for a Diff Review, Sonnet 5.5 for a Dynamic Review", () => {
    expect(adapter.defaultModels).toEqual({
      diff: "claude-haiku-5-5",
      dynamic: "claude-sonnet-5-5",
    });
  });

  // #511-T03
  it("prices a listed model by its list price and an unlisted one not at all", () => {
    expect(adapter.priceOf("claude-haiku-5-5")).toEqual({
      inputPerMillion: 0.1,
      outputPerMillion: 0.5,
      contextTokens: 1_000_000,
      inputTokenFactor: 1.4,
    });
    expect(adapter.priceOf("claude-opus-4-5-20251101")).toMatchObject({
      inputPerMillion: 5,
      outputPerMillion: 25,
      contextTokens: 200_000,
    });
    for (const id of [
      "claude-haiku-5-5-latest",
      "constructor",
      "__proto__",
      "",
    ])
      expect(adapter.priceOf(id), id).toBeNull();
  });

  // #511-T10
  it("answers the capability check from its list, without a request", async () => {
    let requests = 0;
    const fetchImpl = () => {
      requests += 1;
      return Promise.reject(new Error("no network in this test"));
    };

    const dynamic = await adapter.checkModelCapabilities({
      baseUrl: "http://unreachable.invalid",
      modelId: "claude-sonnet-5",
      fetchImpl,
    });
    expect(dynamic).toMatchObject({
      outcome: "supported",
      capabilities: {
        tools: true,
        toolChoice: true,
        toolChoiceRequired: true,
        contextLength: 1_000_000,
        maxCompletionTokens: 128_000,
        inputUsdPerMtok: "2",
        outputUsdPerMtok: "10",
      },
    });
    for (const modelId of [
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5",
    ])
      expect(
        await adapter.checkModelCapabilities({
          baseUrl: "http://unreachable.invalid",
          modelId,
          fetchImpl,
        }),
        modelId,
      ).toMatchObject({
        // #533-T17: the runner steers these, so a Dynamic Review is possible on them.
        outcome: "supported",
        capabilities: { tools: true, toolChoiceRequired: true },
      });
    expect(
      await adapter.checkModelCapabilities({
        baseUrl: "http://unreachable.invalid",
        modelId: "anthropic/claude-sonnet-5",
        fetchImpl,
      }),
    ).toEqual({ outcome: "unknown_model" });
    expect(requests).toBe(0);
  });

  // #511-T11
  it("gives the descriptor of a Dynamic job the window, the allowance and the highest tier price of the model", async () => {
    const haiku = await adapter.checkModelCapabilities({
      baseUrl: "http://unreachable.invalid",
      modelId: "claude-haiku-5-5",
    });
    if (haiku.outcome !== "supported") throw new Error("expected supported");
    // The price reserved against the cost limit is the one of a prompt over 100000 tokens.
    expect(dynamicCapabilitiesOf(haiku.capabilities)).toEqual({
      toolChoiceRequired: true,
      structuredOutput: true,
      maxOutputTokens: 32_768,
      contextWindowTokens: 1_000_000,
      inputUsdPerMtok: "0.5",
      outputUsdPerMtok: "2.5",
    });

    const sonnet = await adapter.checkModelCapabilities({
      baseUrl: "http://unreachable.invalid",
      modelId: "claude-sonnet-5",
    });
    if (sonnet.outcome !== "supported") throw new Error("expected supported");
    expect(dynamicCapabilitiesOf(sonnet.capabilities)).toMatchObject({
      maxOutputTokens: 8192,
      contextWindowTokens: 1_000_000,
      inputUsdPerMtok: "2",
      outputUsdPerMtok: "10",
    });

    const small = await adapter.checkModelCapabilities({
      baseUrl: "http://unreachable.invalid",
      modelId: "claude-haiku-4-5-20251001",
    });
    if (small.outcome !== "supported") throw new Error("expected supported");
    expect(dynamicCapabilitiesOf(small.capabilities)).toMatchObject({
      contextWindowTokens: 200_000,
    });
  });
});
