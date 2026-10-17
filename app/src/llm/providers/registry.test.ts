// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { LLM_PROVIDERS } from "../config.ts";
import { createFakeAdapter, FAKE_PROVIDER_ID } from "./fake-adapter.ts";
import { llmProviderDescriptors } from "./index.ts";
import {
  createAdapterRegistry,
  PROVIDER_REGISTRY_ERROR_CODES,
  ProviderRegistryError,
} from "./registry.ts";
import { llmProviderAdapters } from "./server.ts";
import type { LlmProviderAdapter } from "./types.ts";

function codeOf(build: () => unknown): string | undefined {
  try {
    build();
  } catch (error) {
    if (error instanceof ProviderRegistryError) return error.code;
    throw error;
  }
  return undefined;
}

describe("the provider registry", () => {
  // #423-T02
  it("lists exactly the providers the app supported before the registry", () => {
    expect([...LLM_PROVIDERS]).toEqual(["openrouter"]);
    expect([...llmProviderDescriptors.ids]).toEqual(["openrouter"]);
    expect([...llmProviderAdapters.ids]).toEqual(["openrouter"]);
  });

  // #423-T02
  it("derives the server registry from the same providers as the client-safe one", () => {
    expect(llmProviderAdapters.ids).toEqual(llmProviderDescriptors.ids);
    for (const adapter of llmProviderAdapters.providers) {
      expect(llmProviderDescriptors.get(adapter.id).label).toBe(adapter.label);
    }
  });

  // #423-T04
  it("keeps the secret names of the one provider as they are stored today", () => {
    expect(llmProviderDescriptors.get("openrouter").secretNames).toEqual({
      workspace: "llm_api_key",
      operator: "operator_llm_key",
    });
  });

  // #423-T03
  it.each([
    "id",
    "label",
    "apiBaseUrl",
    "secretNames",
    "checkModelId",
    "testKey",
    "checkModelCapabilities",
    "suggestedModels",
    "priceOf",
    "defaultModels",
    "costReporting",
  ] as const)("refuses an adapter that misses %s", (member) => {
    const incomplete: Partial<LlmProviderAdapter> = createFakeAdapter();
    delete incomplete[member];

    expect(
      codeOf(() => createAdapterRegistry([incomplete as LlmProviderAdapter])),
    ).toBe("provider_member_missing");
  });

  // #423-T03
  it("fails the type check for an adapter that misses a member", () => {
    const withoutPrice: Omit<LlmProviderAdapter, "priceOf"> =
      createFakeAdapter();
    // @ts-expect-error `priceOf` is required by the adapter type
    const adapter: LlmProviderAdapter = withoutPrice;
    expect(adapter.id).toBe(FAKE_PROVIDER_ID);
  });

  // #423-T03
  it.each([
    ["an id with capitals", { id: "FakeAI" }],
    ["an id that is too short", { id: "f" }],
    ["an id with a dot", { id: "fake.ai" }],
    ["a label that is empty", { label: "  " }],
    ["a base URL that is not http(s)", { apiBaseUrl: "ftp://x.example" }],
    [
      "a cost reporting the type does not know",
      { costReporting: "guess" as never },
    ],
    [
      "a default model its own model-id rule refuses",
      { defaultModels: { diff: "Not A Model", dynamic: "fake-large" } },
    ],
    [
      "a suggested model its own model-id rule refuses",
      { suggestedModels: ["fake-small", "UPPER CASE"] },
    ],
    [
      "an empty secret name",
      { secretNames: { workspace: "", operator: "operator_llm_key.x" } },
    ],
  ] as const)("refuses an adapter with %s", (_name, override) => {
    expect(
      codeOf(() => createAdapterRegistry([createFakeAdapter({ ...override })])),
    ).toBe("provider_member_invalid");
  });

  // #423-T03
  it("refuses an empty list, two adapters with one id and two adapters sharing a secret name", () => {
    expect(codeOf(() => createAdapterRegistry([]))).toBe("registry_empty");
    expect(
      codeOf(() =>
        createAdapterRegistry([createFakeAdapter(), createFakeAdapter()]),
      ),
    ).toBe("provider_id_duplicate");
    expect(
      codeOf(() =>
        createAdapterRegistry([
          createFakeAdapter(),
          createFakeAdapter({
            id: "otherai",
            secretNames: {
              workspace: `llm_api_key.${FAKE_PROVIDER_ID}`,
              operator: "operator_llm_key.otherai",
            },
          }),
        ]),
      ),
    ).toBe("provider_secret_name_taken");
  });

  // #423-T03
  it("has a stable list of error codes", () => {
    expect([...PROVIDER_REGISTRY_ERROR_CODES]).toEqual([
      "registry_empty",
      "provider_member_missing",
      "provider_member_invalid",
      "provider_id_duplicate",
      "provider_secret_name_taken",
    ]);
  });

  // #423-T06
  it("serves a second adapter that exists only in the test, the first one stays the default", () => {
    const registry = createAdapterRegistry([
      ...llmProviderAdapters.providers,
      createFakeAdapter(),
    ]);

    expect([...registry.ids]).toEqual(["openrouter", FAKE_PROVIDER_ID]);
    expect(registry.defaultProvider.id).toBe("openrouter");
    expect(registry.find(" FakeAI ")?.id).toBe(FAKE_PROVIDER_ID);
    expect(registry.find("unknown")).toBeUndefined();
    expect(registry.find(undefined)).toBeUndefined();
    expect(registry.find({ id: "openrouter" })).toBeUndefined();
    expect(registry.get(FAKE_PROVIDER_ID).label).toBe("FakeAI");
    expect(registry.operatorSecretNames).toEqual([
      "operator_llm_key",
      `operator_llm_key.${FAKE_PROVIDER_ID}`,
    ]);
    expect(registry.workspaceSecretNames).toEqual([
      "llm_api_key",
      `llm_api_key.${FAKE_PROVIDER_ID}`,
    ]);
  });
});
