// SPDX-License-Identifier: LicenseRef-Proprietary

// The derivation of the supported-provider file (#548): which models.dev providers the pinned OpenCode can drive with a
// static key, with which wire family, and which are left out and why.
import { describe, expect, it } from "vitest";
import { deriveProviders } from "./derive.ts";

const PIN = { version: "1.19.0", commit: "a".repeat(40) };

function provider(npm: string, api?: string) {
  return {
    id: "x",
    name: "X",
    npm,
    ...(api === undefined ? {} : { api }),
    models: {},
  };
}

const BODY = {
  deepseek: provider("@ai-sdk/openai-compatible", "https://api.deepseek.com"),
  openai: provider("@ai-sdk/openai"),
  xai: provider("@ai-sdk/xai"),
  anthropic: provider("@ai-sdk/anthropic"),
  minimax: provider("@ai-sdk/anthropic", "https://api.minimax.io/anthropic/v1"),
  google: provider("@ai-sdk/google"),
  openrouter: provider(
    "@openrouter/ai-sdk-provider",
    "https://openrouter.ai/api/v1",
  ),
  groq: provider("@ai-sdk/groq"),
  "amazon-bedrock": provider("@ai-sdk/amazon-bedrock"),
  "google-vertex": provider("@ai-sdk/google-vertex"),
  "google-vertex-anthropic": provider("@ai-sdk/google-vertex/anthropic"),
  azure: provider("@ai-sdk/azure"),
  "azure-cognitive-services": provider("@ai-sdk/azure"),
  "github-copilot": provider(
    "@ai-sdk/openai-compatible",
    "https://api.githubcopilot.com",
  ),
  gitlab: provider("gitlab-ai-provider"),
  "sap-ai-core": provider("@jerome-benoit/sap-ai-provider-v2"),
  "cloudflare-workers-ai": provider(
    "@ai-sdk/openai-compatible",
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
  ),
  "cloudflare-ai-gateway": provider("ai-gateway-provider"),
  "snowflake-cortex": provider(
    "@ai-sdk/openai-compatible",
    "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1",
  ),
  venice: provider("venice-ai-sdk-provider"),
  aihubmix: provider("@aihubmix/ai-sdk-provider"),
  "merge-gateway": provider(
    "merge-gateway-ai-sdk-provider",
    "https://api-gateway.merge.dev/v1/ai-sdk",
  ),
  qvac: provider("@qvac/ai-sdk-provider"),
  watsonx: provider("watsonx-ai-provider"),
  "salad-cloud": provider("@saladtechnologies-oss/ai-sdk-provider"),
  cohere: provider("@ai-sdk/cohere"),
  vercel: provider("@ai-sdk/gateway"),
  "made-up-without-address": provider("@ai-sdk/openai-compatible"),
  "made-up-templated": provider(
    "@ai-sdk/openai-compatible",
    "https://${TENANT}.example.com/v1",
  ),
  "made-up-unknown-sdk": provider("some-new-sdk", "https://api.example.com/v1"),
};

describe("deriving the supported providers", () => {
  const file = deriveProviders(BODY, PIN);

  // #548-T05
  it.each([
    ["amazon-bedrock", "cloud_iam"],
    ["google-vertex", "cloud_iam"],
    ["google-vertex-anthropic", "cloud_iam"],
    ["azure", "cloud_iam"],
    ["azure-cognitive-services", "cloud_iam"],
    ["sap-ai-core", "cloud_iam"],
    ["cloudflare-workers-ai", "cloud_iam"],
    ["cloudflare-ai-gateway", "cloud_iam"],
    ["snowflake-cortex", "cloud_iam"],
    ["github-copilot", "oauth"],
    ["gitlab", "oauth"],
    ["venice", "runtime_install"],
    ["aihubmix", "runtime_install"],
    ["merge-gateway", "runtime_install"],
    ["qvac", "runtime_install"],
    ["watsonx", "runtime_install"],
    ["salad-cloud", "runtime_install"],
    ["cohere", "wire_not_supported"],
    ["vercel", "wire_not_supported"],
    ["made-up-without-address", "no_base_url"],
    ["made-up-unknown-sdk", "runtime_install"],
  ])("leaves %s out as %s", (id, reason) => {
    expect(file.providers[id]).toEqual({ excluded: reason });
  });

  // #548-T05
  it("treats a templated address as the account's own, whatever the reason an id table gives", () => {
    expect(file.providers["made-up-templated"]).toEqual({
      excluded: "templated_base_url",
    });
  });

  // #548-T05
  it("gives each supported provider its SDK, wire family, key header and, where models.dev has none, the SDK's own address", () => {
    expect(file.providers.deepseek).toEqual({
      npm: "@ai-sdk/openai-compatible",
      family: "openai-chat",
      authHeader: "Authorization",
    });
    expect(file.providers.openai).toEqual({
      npm: "@ai-sdk/openai",
      family: "openai-responses",
      authHeader: "Authorization",
      defaultBaseUrl: "https://api.openai.com/v1",
    });
    expect(file.providers.xai).toMatchObject({ family: "openai-responses" });
    expect(file.providers.anthropic).toEqual({
      npm: "@ai-sdk/anthropic",
      family: "anthropic-messages",
      authHeader: "x-api-key",
      defaultBaseUrl: "https://api.anthropic.com/v1",
    });
    expect(file.providers.minimax).not.toHaveProperty("defaultBaseUrl");
    expect(file.providers.google).toMatchObject({
      family: "google",
      authHeader: "x-goog-api-key",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    expect(file.providers.openrouter).toMatchObject({ family: "openai-chat" });
    expect(file.providers.groq).toMatchObject({
      family: "openai-chat",
      defaultBaseUrl: "https://api.groq.com/openai/v1",
    });
  });

  // #548-T05
  it("accounts for every provider of the body and records the pin it was derived for", () => {
    expect(Object.keys(file.providers).sort()).toEqual(
      Object.keys(BODY).sort(),
    );
    expect(file.opencode).toEqual(PIN);
    expect(file.version).toBe(1);
  });

  // #548-T05
  it("lists the providers in a stable order", () => {
    expect(Object.keys(file.providers)).toEqual(
      Object.keys(file.providers).slice().sort(),
    );
  });
});
