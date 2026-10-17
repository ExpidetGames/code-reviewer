// SPDX-License-Identifier: Apache-2.0

// A second provider that exists only in tests (#423): it proves that nothing in the registry or in its
// users assumes the one real provider. Never imported by production code.
import type { LlmProviderAdapter } from "./types.ts";

export const FAKE_PROVIDER_ID = "fakeai";

export function createFakeAdapter(
  overrides: Partial<LlmProviderAdapter> = {},
): LlmProviderAdapter {
  return {
    id: FAKE_PROVIDER_ID,
    label: "FakeAI",
    apiBaseUrl: "https://api.fakeai.example/v1",
    secretNames: {
      workspace: `llm_api_key.${FAKE_PROVIDER_ID}`,
      operator: `operator_llm_key.${FAKE_PROVIDER_ID}`,
    },
    checkModelId: (id) => /^[a-z][a-z0-9-]{0,40}$/.test(id),
    testKey: () => Promise.resolve({ ok: true }),
    checkModelCapabilities: () =>
      Promise.resolve({ outcome: "unverifiable" as const }),
    suggestedModels: ["fake-small", "fake-large"],
    priceOf: (model) =>
      model === "fake-small"
        ? {
            inputPerMillion: 1,
            outputPerMillion: 2,
            contextTokens: 100_000,
            inputTokenFactor: 1,
          }
        : null,
    defaultModels: { diff: "fake-small", dynamic: "fake-large" },
    costReporting: "none",
    ...overrides,
  };
}
