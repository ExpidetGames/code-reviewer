// SPDX-License-Identifier: LicenseRef-Proprietary

// The committed supported-provider file (#548, part B): `contracts/opencode-providers.v1.json`, tied to the pin of
// OpenCode, and the copy the app image carries (the image holds `app/` only).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPENCODE_PROVIDERS,
  excludedReason,
  supportedProvider,
} from "./opencode-providers.ts";
import { AUTH_HEADER_OF_FAMILY, BUNDLED_NPM } from "./wire.ts";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..");
const contractText = readFileSync(
  join(REPOSITORY, "contracts", "opencode-providers.v1.json"),
  "utf8",
);

describe("the supported-provider file", () => {
  // #548-T05
  it.each([
    ["amazon-bedrock", "cloud_iam"],
    ["google-vertex", "cloud_iam"],
    ["google-vertex-anthropic", "cloud_iam"],
    ["azure", "cloud_iam"],
    ["azure-cognitive-services", "cloud_iam"],
    ["github-copilot", "oauth"],
    ["gitlab", "oauth"],
    ["sap-ai-core", "cloud_iam"],
    ["cloudflare-workers-ai", "cloud_iam"],
    ["cloudflare-ai-gateway", "cloud_iam"],
    ["snowflake-cortex", "cloud_iam"],
    ["venice", "runtime_install"],
    ["aihubmix", "runtime_install"],
    ["merge-gateway", "runtime_install"],
    ["qvac", "runtime_install"],
    ["watsonx", "runtime_install"],
    ["salad-cloud", "runtime_install"],
  ])("leaves %s out as %s, and never offers it", (id, reason) => {
    expect(excludedReason(id)).toBe(reason);
    expect(supportedProvider(id)).toBeUndefined();
  });

  // #548-T05
  it("offers the providers of the four wire families", () => {
    expect(supportedProvider("deepseek")).toMatchObject({
      family: "openai-chat",
    });
    expect(supportedProvider("openai")).toMatchObject({
      family: "openai-responses",
      defaultBaseUrl: "https://api.openai.com/v1",
    });
    expect(supportedProvider("anthropic")).toMatchObject({
      family: "anthropic-messages",
    });
    expect(supportedProvider("google")).toMatchObject({ family: "google" });
  });

  // #548-T05
  it("gives every supported provider the key header of its family", () => {
    const entries = Object.values(OPENCODE_PROVIDERS.providers).filter(
      (entry) => "family" in entry,
    );
    expect(entries.length).toBeGreaterThan(100);
    for (const entry of entries)
      expect(entry.authHeader).toBe(AUTH_HEADER_OF_FAMILY[entry.family]);
  });

  // #548-T05
  it("offers only SDKs the pinned OpenCode bundles", () => {
    const sdks = new Set(
      Object.values(OPENCODE_PROVIDERS.providers).flatMap((entry) =>
        "npm" in entry ? [entry.npm] : [],
      ),
    );
    expect(sdks.size).toBeGreaterThan(5);
    for (const sdk of sdks) expect(BUNDLED_NPM).toContain(sdk);
  });

  // #548-T06
  it("records the commit of the pinned OpenCode, and fails when the pin moves without it", () => {
    const pin = JSON.parse(
      readFileSync(join(REPOSITORY, "runner", "opencode-pin.json"), "utf8"),
    ) as { version: string; commit: string };
    expect(OPENCODE_PROVIDERS.opencode).toEqual({
      version: pin.version,
      commit: pin.commit,
    });
  });

  // #548-T06
  it("is the same file as the contract, which the app image cannot read", () => {
    const copy = readFileSync(
      join(import.meta.dirname, "opencode-providers.v1.json"),
      "utf8",
    );
    expect(copy).toBe(contractText);
  });

  // #548-T05
  it("does not know a provider that models.dev may add later", () => {
    expect(supportedProvider("a-provider-from-next-week")).toBeUndefined();
    expect(excludedReason("a-provider-from-next-week")).toBeUndefined();
  });
});
