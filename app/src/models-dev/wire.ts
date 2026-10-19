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
