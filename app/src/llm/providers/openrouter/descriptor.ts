// SPDX-License-Identifier: LicenseRef-Proprietary

// The part of the OpenRouter adapter that is data and pure rules, safe for a client component to import. The
// only file besides its siblings that names the provider; everything else in the app reads it through the
// registry (../index.ts).
import type { LlmProviderDescriptor } from "../types.ts";
import { MODEL_PRICES } from "./model-pricing.ts";

/**
 * What the runner accepts for `llm.model` (runner/README.md, "llm"): a model id is refused here when the
 * runner would refuse the job, so it shows up in the UI instead of as a failed job.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;

export const checkModelId = (id: string): boolean => MODEL_ID_PATTERN.test(id);

export const openrouterDescriptor = {
  id: "openrouter",
  label: "OpenRouter",
  apiBaseUrl: "https://openrouter.ai/api/v1",
  // The names the keys are stored under. The ciphertext is bound to them (src/secrets/), so they never change:
  // a stored key would stop decrypting (ADR 0005, 2.5).
  secretNames: { workspace: "llm_api_key", operator: "operator_llm_key" },
  checkModelId,
  suggestedModels: Object.keys(MODEL_PRICES),
  priceOf: (model) =>
    Object.hasOwn(MODEL_PRICES, model) ? (MODEL_PRICES[model] ?? null) : null,
  defaultModels: {
    /**
     * The recommendation of the model comparison (measured 0.0027 USD per review on average against the
     * customer's limit of 0.10 USD).
     */
    diff: "anthropic/claude-haiku-5.5",
    dynamic: "deepseek/deepseek-v4.1-flash",
  },
  // OpenRouter reports the charge of every call (`usage.cost`), which all cost enforcement relies on.
  costReporting: "provider_reported",
} as const satisfies LlmProviderDescriptor;
