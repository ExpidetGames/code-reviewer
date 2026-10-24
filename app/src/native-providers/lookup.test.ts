// SPDX-License-Identifier: LicenseRef-Proprietary

// The lookup that lets the key service and the claim know a catalog provider by its slug (#555), next to the two providers of
// the registry. Pure: the supported file is data.
import { describe, expect, it } from "vitest";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import {
  NATIVE_KEY_SECRET_PREFIX,
  nativeKeySecretName,
  withNativeProviders,
} from "./lookup.ts";

const lookup = withNativeProviders(llmProviderDescriptors);

describe("the providers a key can be stored for", () => {
  // #555-T01
  it("finds a supported catalog provider by its slug and names its secret after the slug", () => {
    expect(lookup.find("deepseek")).toMatchObject({
      id: "deepseek",
      secretNames: { workspace: "llm_api_key.deepseek" },
    });
    // The underscore of a slug is the hyphen of the models.dev id.
    expect(lookup.find("fireworks_ai")?.id).toBe("fireworks_ai");
    expect(nativeKeySecretName("fireworks_ai")).toBe(
      `${NATIVE_KEY_SECRET_PREFIX}fireworks_ai`,
    );
  });

  // #555-T01
  it("never finds an excluded provider, an unknown one or a spelling that is no slug", () => {
    for (const raw of [
      "amazon_bedrock",
      "google_vertex",
      "no_such_provider",
      "fireworks-ai",
      "",
      " ",
      "../x",
      42,
      undefined,
    ])
      expect(lookup.find(raw)).toBeUndefined();
  });

  // #555-T01
  it("keeps the registry's own providers as they are and does not list catalog providers among its ids", () => {
    expect(lookup.find("openrouter")?.secretNames.workspace).toBe(
      "llm_api_key",
    );
    expect(lookup.find("anthropic")?.secretNames.workspace).toBe(
      "llm_api_key.anthropic",
    );
    expect(lookup.ids).toEqual(llmProviderDescriptors.ids);
  });

  // #555-T06
  it("trims and folds the case of what a request wrote, like the registry", () => {
    expect(lookup.find("  DeepSeek ")?.id).toBe("deepseek");
  });
});
