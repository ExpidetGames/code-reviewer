// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createLlmAccess } from "./access.ts";
import { resolveWorkspaceLlmAccess, type ResolveLlmInput } from "./resolve.ts";

const WORKSPACE_KEY = "sk-or-v1-workspace-key-aaaaaaaaaaaaaaaa";
const OPERATOR_KEY = "sk-or-v1-operator-key-cccccccccccccccc";

function input(overrides: Partial<ResolveLlmInput> = {}): ResolveLlmInput {
  return {
    key: { state: "none" },
    operator: null,
    defaults: { model: "vendor/default-model", contextWindowTokens: null },
    ...overrides,
  };
}

describe("which LLM access a workspace gets", () => {
  // #104-LK-01
  it("uses the key of the workspace, with the instance's default model", () => {
    const result = resolveWorkspaceLlmAccess(
      input({
        key: { state: "key", binding: "openrouter", apiKey: WORKSPACE_KEY },
        defaults: {
          model: "vendor/default-model",
          contextWindowTokens: 50_000,
        },
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      source: "workspace",
      access: {
        provider: "openrouter",
        model: "vendor/default-model",
        apiKey: WORKSPACE_KEY,
        contextWindowTokens: 50_000,
      },
    });
  });

  // #104-LK-01
  it("fails with llm_not_configured when the workspace has no key and nothing else applies", () => {
    expect(resolveWorkspaceLlmAccess(input())).toEqual({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "no_key",
      issues: [],
    });
  });

  // #104-LK-01
  it("uses the operator's key only when the operator offers included usage", () => {
    const operator = createLlmAccess({
      provider: "openrouter",
      model: "vendor/operator-model",
      apiKey: OPERATOR_KEY,
      contextWindowTokens: null,
    });

    const off = resolveWorkspaceLlmAccess(input({ operator: null }));
    const on = resolveWorkspaceLlmAccess(input({ operator }));

    expect(off.ok).toBe(false);
    expect(on).toMatchObject({
      ok: true,
      source: "operator",
      access: { apiKey: OPERATOR_KEY },
    });
  });

  // #104-LK-01
  it("prefers the workspace key over the operator's", () => {
    const operator = createLlmAccess({
      provider: "openrouter",
      model: "m/m",
      apiKey: OPERATOR_KEY,
      contextWindowTokens: null,
    });

    const result = resolveWorkspaceLlmAccess(
      input({
        key: { state: "key", binding: "openrouter", apiKey: WORKSPACE_KEY },
        operator,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      source: "workspace",
      access: { apiKey: WORKSPACE_KEY },
    });
  });

  // #106-LK-12
  it("does not look at the legacy environment variables any more: a workspace without a key has none", () => {
    // The variables were imported into the default workspace once (src/legacy-import/); the resolver has no
    // input for them, so no environment can give a workspace a key.
    expect(resolveWorkspaceLlmAccess(input())).toMatchObject({
      ok: false,
      reason: "no_key",
    });
  });

  it("fails closed for a workspace key that cannot be read, instead of using another key", () => {
    const result = resolveWorkspaceLlmAccess(
      input({
        key: { state: "unreadable" },
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "key_unreadable" });
  });

  // #104-LK-01 (the lesson of #100: a stored secret is never carried to another endpoint)
  it("fails closed for a workspace key that was made for another provider", () => {
    const result = resolveWorkspaceLlmAccess(
      input({
        key: {
          state: "key",
          binding: "some-other-provider",
          apiKey: WORKSPACE_KEY,
        },
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "key_binding_mismatch" });
  });

  it("keeps the key of the access out of JSON and logs", () => {
    const result = resolveWorkspaceLlmAccess(
      input({
        key: { state: "key", binding: "openrouter", apiKey: WORKSPACE_KEY },
      }),
    );

    expect(JSON.stringify(result)).not.toContain(WORKSPACE_KEY);
  });
});
