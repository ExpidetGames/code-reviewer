// SPDX-License-Identifier: Apache-2.0

// The address the app talks to when it checks an LLM key (the "test key" button) or reads a model's metadata. It is the provider's own API
// and nothing a person can choose: there is no field for an address, no per-workspace setting, nothing from a
// request. Like the GitHub addresses (src/github-endpoints.ts) it can be changed by the operator's environment
// for the test stack only: `LLM_API_BASE_URL` is honoured together with `ALLOW_TEST_LLM_ENDPOINTS=true`, which
// only the tests set (it points the app at the fake LLM, fakes/llm). Without the flag any other address is
// ignored and the real provider is used, so a key is never sent to an address an environment variable names by
// accident. (The address a RUNNER sends the key to is the runner's own business and not set here.)
import { resolveGithubEndpoint } from "../github-endpoints.ts";
import type { LlmProvider } from "./config.ts";
import { llmProviderDescriptors } from "./providers/index.ts";

export const ALLOW_TEST_LLM_ENDPOINTS_FLAG = "ALLOW_TEST_LLM_ENDPOINTS";

type Env = Readonly<Record<string, string | undefined>>;

export type LlmEndpoint = {
  url: string;
  /** True when the environment named an address that is not allowed and the real one is used instead. */
  overrideIgnored: boolean;
};

export function llmApiBaseUrl(env: Env, provider: LlmProvider): LlmEndpoint {
  const fallback = llmProviderDescriptors.get(provider).apiBaseUrl;
  const resolved = resolveGithubEndpoint(
    env.LLM_API_BASE_URL,
    fallback,
    env[ALLOW_TEST_LLM_ENDPOINTS_FLAG]?.trim() === "true",
  );
  return resolved.ok
    ? { url: resolved.url, overrideIgnored: false }
    : { url: fallback, overrideIgnored: true };
}
