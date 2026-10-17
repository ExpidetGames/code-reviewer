// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { ProviderRegistryError } from "../llm/providers/registry.ts";
import {
  FIXED_SECRET_NAMES,
  isSecretName,
  secretNamesOf,
  SECRET_NAMES,
  WORKSPACE_SECRET_NAMES,
} from "./names.ts";

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

  // #423-T04
  it("lists every name once", () => {
    expect(new Set(SECRET_NAMES).size).toBe(SECRET_NAMES.length);
  });

  // #423-T04
  it("refuses an operator key name of a provider that is a fixed secret name of the instance", () => {
    for (const fixed of FIXED_SECRET_NAMES) {
      const attempt = () => secretNamesOf(["operator_llm_key", fixed]);
      expect(attempt).toThrow(ProviderRegistryError);
      expect(attempt).toThrow(/provider_secret_name_taken/);
    }
  });

  // #423-T04
  it("refuses two providers with one operator key name", () => {
    expect(() =>
      secretNamesOf(["operator_llm_key", "operator_llm_key"]),
    ).toThrow(/provider_secret_name_taken/);
  });

  // #423-T04
  it("sorts the fixed names and the operator key names together", () => {
    expect(secretNamesOf(["operator_llm_key.zzz", "operator_llm_key"])).toEqual(
      [
        "github_app_client_secret",
        "github_app_private_key",
        "github_app_webhook_secret",
        "operator_llm_key",
        "operator_llm_key.zzz",
        "smtp_password",
      ],
    );
  });
});
