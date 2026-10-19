// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_PROVIDER } from "../llm/providers/index.ts";
import { createFakeAdapter } from "../llm/providers/fake-adapter.ts";
import { openrouterDescriptor } from "../llm/providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "../llm/providers/registry.ts";
import { parseOperatorKeyChange } from "./operator-key-change.ts";

const KEY = "sk-or-v1-operator-key-0123456789abcdef-wxyz";
const providers = createProviderRegistry([
  openrouterDescriptor,
  createFakeAdapter(),
]);

describe("the request that changes an operator key", () => {
  // #427-T06
  it("reads the old shape { operatorLlmKey } as a change of the key of the default provider", () => {
    expect(
      parseOperatorKeyChange("operatorLlmKey", { apiKey: KEY }, providers),
    ).toEqual({
      ok: true,
      provider: DEFAULT_LLM_PROVIDER,
      change: { apiKey: KEY },
    });
    expect(parseOperatorKeyChange("operatorLlmKey", null, providers)).toEqual({
      ok: true,
      provider: DEFAULT_LLM_PROVIDER,
      change: null,
    });
  });

  // #427-T06
  it("hands the value of the old shape on as it is, for the key service to judge", () => {
    expect(
      parseOperatorKeyChange("operatorLlmKey", { apiKey: 42 }, providers),
    ).toEqual({
      ok: true,
      provider: DEFAULT_LLM_PROVIDER,
      change: { apiKey: 42 },
    });
    for (const value of [undefined, "text", 3, [], [KEY]])
      expect(
        parseOperatorKeyChange("operatorLlmKey", value, providers),
      ).toEqual({
        ok: false,
        issues: [{ field: "operatorLlmKey", code: "operator_llm_key_invalid" }],
      });
  });

  // #427-T01
  it("reads { operatorLlmKeys: { <provider>: { apiKey } | null } } as a change of that provider's key only", () => {
    expect(
      parseOperatorKeyChange(
        "operatorLlmKeys",
        { fakeai: { apiKey: KEY } },
        providers,
      ),
    ).toEqual({ ok: true, provider: "fakeai", change: { apiKey: KEY } });
    expect(
      parseOperatorKeyChange("operatorLlmKeys", { fakeai: null }, providers),
    ).toEqual({ ok: true, provider: "fakeai", change: null });
  });

  // #427-T01
  it("changes one provider per request: none, or several, are refused", () => {
    for (const value of [
      {},
      { [DEFAULT_LLM_PROVIDER]: null, fakeai: null },
      { [DEFAULT_LLM_PROVIDER]: { apiKey: KEY }, fakeai: { apiKey: KEY } },
    ])
      expect(
        parseOperatorKeyChange("operatorLlmKeys", value, providers),
      ).toEqual({
        ok: false,
        issues: [
          { field: "operatorLlmKeys", code: "operator_llm_key_invalid" },
        ],
      });
  });

  // #427-T01
  it("refuses a provider that is not registered, or not spelled as its id exactly, instead of choosing another", () => {
    for (const provider of [
      "nobody",
      "OpenRouter",
      " openrouter",
      "openrouter ",
      "__proto__",
      "constructor",
    ])
      expect(
        parseOperatorKeyChange(
          "operatorLlmKeys",
          JSON.parse(`{${JSON.stringify(provider)}: {"apiKey": "${KEY}"}}`),
          providers,
        ),
      ).toEqual({
        ok: false,
        issues: [{ field: "provider", code: "provider_invalid" }],
      });
  });

  // #427-T01
  it("refuses a value that is not an object, or null, for the provider", () => {
    for (const value of [undefined, null, "text", 3, [], [{ apiKey: KEY }]])
      expect(
        parseOperatorKeyChange("operatorLlmKeys", value, providers),
      ).toEqual({
        ok: false,
        issues: [
          { field: "operatorLlmKeys", code: "operator_llm_key_invalid" },
        ],
      });
    for (const value of ["text", 3, [], true])
      expect(
        parseOperatorKeyChange(
          "operatorLlmKeys",
          { [DEFAULT_LLM_PROVIDER]: value },
          providers,
        ),
      ).toEqual({
        ok: false,
        issues: [
          { field: "operatorLlmKeys", code: "operator_llm_key_invalid" },
        ],
      });
  });
});
