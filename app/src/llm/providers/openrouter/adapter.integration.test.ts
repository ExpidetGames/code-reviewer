// SPDX-License-Identifier: Apache-2.0

// #423-T05: the two network operations of the adapter against the fake LLM over real HTTP, as the key-test and
// model-capabilities suites exercise them, but reached through the registry (the way every caller now does).
import { describe, expect, it } from "vitest";
import { startLlmFake } from "../../../../../fakes/llm/server.ts";
import { cleanUpAfterTest } from "../../../test-support/test-database.ts";
import { llmProviderAdapters } from "../server.ts";

const KEY = "sk-or-v1-dummy-0123456789abcdef0123456789abcdef";
const adapter = llmProviderAdapters.get("openrouter");

async function setup() {
  const fake = await startLlmFake();
  cleanUpAfterTest(() => fake.close());
  return fake;
}

describe("the OpenRouter adapter against the fake LLM", () => {
  // #423-T05
  it("tests an accepted key and reports a rejected one with the same code as before", async () => {
    const fake = await setup();
    fake.acceptKeys([KEY]);

    expect(
      await adapter.testKey({ baseUrl: fake.baseUrl, apiKey: KEY }),
    ).toEqual({ ok: true });
    const rejected = await adapter.testKey({
      baseUrl: fake.baseUrl,
      apiKey: "another-key",
    });
    expect(rejected).toMatchObject({ ok: false, error: "llm_key_rejected" });
    expect(fake.keyChecks()).toEqual([`Bearer ${KEY}`, "Bearer another-key"]);
  });

  // #423-T05
  it("reads the capabilities of a model without sending a credential", async () => {
    const fake = await setup();
    fake.setModel("vendor/tooled", [
      {
        supported_parameters: ["tools", "tool_choice"],
        max_completion_tokens: 8000,
        context_length: 128_000,
        pricing: { prompt: "0.0000005", completion: "0.000002" },
      },
    ]);

    const result = await adapter.checkModelCapabilities({
      baseUrl: fake.baseUrl,
      modelId: "vendor/tooled",
    });

    expect(result).toMatchObject({
      outcome: "supported",
      capabilities: {
        contextLength: 128_000,
        inputUsdPerMtok: "0.5",
        outputUsdPerMtok: "2",
      },
    });
    expect(fake.modelRequests()).toEqual([
      { path: "/api/v1/models/vendor/tooled/endpoints", authorization: "" },
    ]);
  });

  // #423-T05
  it("answers unknown_model for a model the provider does not list, and makes no request for a name that cannot be one", async () => {
    const fake = await setup();

    expect(
      await adapter.checkModelCapabilities({
        baseUrl: fake.baseUrl,
        modelId: "vendor/missing",
      }),
    ).toEqual({ outcome: "unknown_model" });
    expect(
      await adapter.checkModelCapabilities({
        baseUrl: fake.baseUrl,
        modelId: "no slash",
      }),
    ).toEqual({ outcome: "unknown_model" });
    expect(fake.modelRequests()).toHaveLength(1);
  });
});
