// SPDX-License-Identifier: Apache-2.0

// The providers the app supports, as far as a client component may know them: data and pure rules, nothing that
// talks to the network. `LLM_PROVIDERS` and `LlmProvider` (src/llm/config.ts) are derived from this list. To
// add a provider, write its adapter in a folder next to `openrouter/` and list it here (descriptor) and in
// `server.ts` (the whole adapter). See src/llm/README.md.
import { openrouterDescriptor } from "./openrouter/descriptor.ts";
import { createProviderRegistry } from "./registry.ts";

export const llmProviderDescriptors = createProviderRegistry([
  openrouterDescriptor,
]);

export type LlmProviderId = (typeof llmProviderDescriptors.ids)[number];

/** The provider a request that names none, the instance's own key and the cost estimate use. */
export const DEFAULT_LLM_PROVIDER: LlmProviderId =
  llmProviderDescriptors.defaultProvider.id;

/** The name of the default provider for the copy that speaks of "the provider" before a project can choose. */
export const DEFAULT_LLM_PROVIDER_LABEL =
  llmProviderDescriptors.defaultProvider.label;
