// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { isSecretName, SECRET_NAMES, WORKSPACE_SECRET_NAMES } from "./names.ts";

describe("the names of the secrets", () => {
  // #423-T04
  it("keeps the names stored today: the ciphertext is bound to them, so a change would make a stored key unreadable", () => {
    expect([...SECRET_NAMES]).toEqual([
      "github_app_client_secret",
      "github_app_private_key",
      "github_app_webhook_secret",
      "operator_llm_key",
      "smtp_password",
    ]);
    expect([...WORKSPACE_SECRET_NAMES]).toEqual(["llm_api_key"]);
  });

  // #423-T04
  it("takes the LLM key names from the provider registry", () => {
    for (const provider of llmProviderDescriptors.providers) {
      expect(isSecretName(provider.secretNames.operator)).toBe(true);
      expect(WORKSPACE_SECRET_NAMES).toContain(provider.secretNames.workspace);
    }
  });
});
