// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { WORKSPACE_LLM_KEY_NAMES } from "../llm/secret-names.ts";
import { composeSecretNames, SecretNamesError } from "../secrets/names.ts";
import { FIXED_SECRET_NAMES } from "../secret-names/names.ts";
import { SECRET_NAMES } from "./secret-names.ts";

const isSecretName = (value: unknown) =>
  SECRET_NAMES.some((name) => name === value);

describe("the names of the secrets", () => {
  // #423-T04
  it("keeps the names stored today: the ciphertext is bound to them, so a change would make a stored key unreadable", () => {
    expect([...SECRET_NAMES]).toEqual([
      "github_app_client_secret",
      "github_app_private_key",
      "github_app_webhook_secret",
      "operator_llm_key",
      "operator_llm_key.anthropic",
      "smtp_password",
      "stripe_api_key",
      "stripe_webhook_secret",
    ]);
    expect([...WORKSPACE_LLM_KEY_NAMES]).toEqual([
      "llm_api_key",
      "llm_api_key.anthropic",
    ]);
  });

  // #491-T07
  it("does not know the names of the removed billing design", () => {
    const vendor = ["pad", "dle"].join("");
    expect(SECRET_NAMES.filter((name) => name.includes(vendor))).toEqual([]);
    expect(isSecretName(`${vendor}_api_key`)).toBe(false);
    expect(isSecretName(`${vendor}_webhook_secret`)).toBe(false);
  });

  // #500-T13
  it("has the two Stripe secrets: the API key and the webhook secret of the endpoint", () => {
    expect(SECRET_NAMES).toContain("stripe_api_key");
    expect(SECRET_NAMES).toContain("stripe_webhook_secret");
    expect(isSecretName("stripe_api_key")).toBe(true);
    expect(isSecretName("stripe_webhook_secret")).toBe(true);
    // Instance secrets only: a workspace never holds a payment provider credential.
    expect(
      WORKSPACE_LLM_KEY_NAMES.filter((name) => name.includes("stripe")),
    ).toEqual([]);
  });

  // #423-T04
  it("takes the LLM key names from the provider registry", () => {
    for (const provider of llmProviderDescriptors.providers) {
      expect(isSecretName(provider.secretNames.operator)).toBe(true);
      expect(WORKSPACE_LLM_KEY_NAMES).toContain(provider.secretNames.workspace);
    }
  });

  // #423-T04
  it("lists every name once", () => {
    expect(new Set(SECRET_NAMES).size).toBe(SECRET_NAMES.length);
  });

  // #423-T04
  it("refuses an operator key name of a provider that is a fixed secret name of the application", () => {
    for (const fixed of FIXED_SECRET_NAMES) {
      const attempt = () =>
        composeSecretNames<string>(FIXED_SECRET_NAMES, [
          "operator_llm_key",
          fixed,
        ]);
      expect(attempt).toThrow(SecretNamesError);
      expect(attempt).toThrow(/secret_name_taken/);
    }
  });
});
