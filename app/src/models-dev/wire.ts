// SPDX-License-Identifier: Apache-2.0

// The vocabulary of the supported-provider file (`contracts/opencode-providers.v1.json`, #548): the four wire families the
// pinned OpenCode speaks to a provider with a static key, the header each family carries the key in, and the stable
// reasons a provider is left out. Data only, no server code: the derivation script (src/ci/opencode-providers/) and the
// catalog both read it.

/** The wire formats a job can use (the study #544, section 3; the spike #546 ran all four). */
export const WIRE_FAMILIES = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google",
] as const;
export type WireFamily = (typeof WIRE_FAMILIES)[number];

/** The header a family's SDK sends the key in: the three the proxy of #550 swaps. */
export const AUTH_HEADERS = [
  "Authorization",
  "x-api-key",
  "x-goog-api-key",
] as const;
export type AuthHeader = (typeof AUTH_HEADERS)[number];

export const AUTH_HEADER_OF_FAMILY = {
  "openai-chat": "Authorization",
  "openai-responses": "Authorization",
  "anthropic-messages": "x-api-key",
  google: "x-goog-api-key",
} as const satisfies Record<WireFamily, AuthHeader>;

/**
 * Why a provider of models.dev is not offered:
 * - `cloud_iam`: signs requests or mints tokens from cloud credentials, so a dummy key cannot stand in for it;
 * - `oauth`: signs in with OAuth, not a static key;
 * - `runtime_install`: its SDK is not bundled in the pinned OpenCode, which would install it at run time, and the VM has
 *   no package install;
 * - `wire_not_supported`: a bundled SDK whose wire is none of the four families (Cohere's own API, the Vercel AI Gateway);
 * - `no_base_url`: models.dev names no address and the SDK has no default we know;
 * - `templated_base_url`: the address holds a `${VARIABLE}` that only the user's account can fill.
 */
export const EXCLUSION_REASONS = [
  "cloud_iam",
  "oauth",
  "runtime_install",
  "wire_not_supported",
  "no_base_url",
  "templated_base_url",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/**
 * The SDKs the pinned OpenCode bundles (`BUNDLED_PROVIDERS` in `packages/opencode/src/provider/provider.ts` at the pin);
 * any other `npm` is installed at run time, which a worker VM cannot do. The derivation of the supported file reads
 * this list, and the entry of a job may name nothing else (`job-entry.ts`, `contracts/job-model-entry.v1.json`,
 * `runner/.../job_model_entry.py`): the SDK decides which code the engine loads, so it is an allow-list, not a pattern.
 * A pin bump is the moment to read it again.
 */
export const BUNDLED_NPM = [
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/amazon-bedrock/mantle",
  "@ai-sdk/anthropic",
  "@ai-sdk/azure",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/google-vertex/anthropic",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/xai",
  "@ai-sdk/mistral",
  "@ai-sdk/groq",
  "@ai-sdk/deepinfra",
  "@ai-sdk/cerebras",
  "@ai-sdk/cohere",
  "@ai-sdk/gateway",
  "@ai-sdk/togetherai",
  "@ai-sdk/perplexity",
  "@ai-sdk/vercel",
  "@ai-sdk/alibaba",
  "gitlab-ai-provider",
  "@ai-sdk/github-copilot",
  "venice-ai-sdk-provider",
] as const;
export type BundledNpm = (typeof BUNDLED_NPM)[number];

/**
 * The names under which a model carries its reasoning in a tool loop, as far as the pinned engine hands it back. The
 * engine (`provider/transform.ts` at the pin) copies the reasoning text into the field it is given, whatever the name; the
 * two here are the ones models.dev states for the models of the supported providers (2026-10-19: `reasoning_content` for
 * about 1,200, `reasoning_details` for about 100) and the ones the engine's own comment names. Any other name is dropped
 * when the catalog is read: the model then runs without handing its reasoning back, which is the engine's default. The
 * engine's schema also lists `reasoning` and `reasoning_text`; no model states them, so they are not offered.
 */
export const INTERLEAVED_FIELDS = [
  "reasoning_content",
  "reasoning_details",
] as const;
export type InterleavedField = (typeof INTERLEAVED_FIELDS)[number];
