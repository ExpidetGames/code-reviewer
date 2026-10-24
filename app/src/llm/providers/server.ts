// SPDX-License-Identifier: LicenseRef-Proprietary

// The providers the server talks to: every adapter with its calls (the key test and the model-capability
// check). The same providers, in the same order, as `index.ts`.
import "server-only";
import { anthropicAdapter } from "./anthropic/adapter.ts";
import { openrouterAdapter } from "./openrouter/adapter.ts";
import { createAdapterRegistry } from "./registry.ts";

export const llmProviderAdapters = createAdapterRegistry([
  openrouterAdapter,
  anthropicAdapter,
]);
