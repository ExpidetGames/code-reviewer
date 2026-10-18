// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ENTITLEMENTS_INVALID_CODE } from "../workspaces/entitlements.ts";
import {
  createFakeAdapter,
  FAKE_PROVIDER_ID,
} from "./providers/fake-adapter.ts";
import { openrouterDescriptor } from "./providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "./providers/registry.ts";
import {
  keyModeForJob,
  resolveWorkspaceLlmAccess,
  type ResolveLlmInput,
} from "./resolve.ts";

const WORKSPACE_KEY = "sk-or-v1-workspace-key-aaaaaaaaaaaaaaaa";
const OPERATOR_KEY = "sk-or-v1-operator-key-cccccccccccccccc";

const DEFAULTS = {
  model: "vendor/default-model",
  contextWindowTokens: null,
} as const;

function own(
  key: Extract<ResolveLlmInput, { keyMode: "own" }>["key"] = {
    state: "none",
  },
): ResolveLlmInput {
  return { keyMode: "own", key, defaults: DEFAULTS };
}

function managed(
  operatorKey: Extract<
    ResolveLlmInput,
    { keyMode: "managed" }
  >["operatorKey"] = { state: "none" },
): ResolveLlmInput {
  return { keyMode: "managed", operatorKey, defaults: DEFAULTS };
}

describe("which LLM access a workspace gets", () => {
  // #104-LK-01
  it("uses the key of the workspace, with the instance's default model", () => {
    const result = resolveWorkspaceLlmAccess({
      keyMode: "own",
      key: { state: "key", binding: "openrouter", apiKey: WORKSPACE_KEY },
      defaults: { model: "vendor/default-model", contextWindowTokens: 50_000 },
    });

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
    expect(resolveWorkspaceLlmAccess(own())).toEqual({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "no_key",
      issues: [],
    });
  });

  // #106-LK-12
  it("does not look at the legacy environment variables any more: a workspace without a key has none", () => {
    // The variables were imported into the default workspace once (src/legacy-import/); the resolver has no
    // input for them, so no environment can give a workspace a key.
    expect(resolveWorkspaceLlmAccess(own())).toMatchObject({
      ok: false,
      reason: "no_key",
    });
  });

  it("fails closed for a workspace key that cannot be read, instead of using another key", () => {
    const result = resolveWorkspaceLlmAccess(own({ state: "unreadable" }));

    expect(result).toMatchObject({ ok: false, reason: "key_unreadable" });
  });

  // #426-T01
  it("takes the key of the provider the job asks for, with that provider in the access", () => {
    const result = resolveWorkspaceLlmAccess({
      keyMode: "own",
      provider: "openrouter",
      key: { state: "key", binding: "openrouter", apiKey: WORKSPACE_KEY },
      defaults: DEFAULTS,
    });

    expect(result).toMatchObject({
      ok: true,
      source: "workspace",
      access: { provider: "openrouter", apiKey: WORKSPACE_KEY },
    });
  });

  // #426-T01
  it("takes the key of a second registered provider when that provider is asked for", () => {
    const result = resolveWorkspaceLlmAccess(
      {
        keyMode: "own",
        provider: FAKE_PROVIDER_ID,
        key: { state: "key", binding: FAKE_PROVIDER_ID, apiKey: WORKSPACE_KEY },
        defaults: DEFAULTS,
      },
      createProviderRegistry([openrouterDescriptor, createFakeAdapter()]),
    );

    expect(result).toMatchObject({
      ok: true,
      source: "workspace",
      access: { provider: FAKE_PROVIDER_ID, apiKey: WORKSPACE_KEY },
    });
  });

  // #426-T01 (a key of one provider is never used for another)
  it("fails closed for a key of a registered provider that is not the one asked for", () => {
    const result = resolveWorkspaceLlmAccess(
      {
        keyMode: "own",
        provider: "openrouter",
        key: { state: "key", binding: FAKE_PROVIDER_ID, apiKey: WORKSPACE_KEY },
        defaults: DEFAULTS,
      },
      createProviderRegistry([openrouterDescriptor, createFakeAdapter()]),
    );

    expect(result).toMatchObject({ ok: false, reason: "key_binding_mismatch" });
  });

  // #104-LK-01 (the lesson of #100: a stored secret is never carried to another endpoint)
  it("fails closed for a workspace key that was made for another provider", () => {
    const result = resolveWorkspaceLlmAccess(
      own({
        state: "key",
        binding: "some-other-provider",
        apiKey: WORKSPACE_KEY,
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "key_binding_mismatch" });
  });

  it("keeps the key of the access out of JSON and logs", () => {
    const result = resolveWorkspaceLlmAccess(
      own({ state: "key", binding: "openrouter", apiKey: WORKSPACE_KEY }),
    );
    const operator = resolveWorkspaceLlmAccess(
      managed({ state: "key", apiKey: OPERATOR_KEY }),
    );

    expect(JSON.stringify(result)).not.toContain(WORKSPACE_KEY);
    expect(JSON.stringify(operator)).not.toContain(OPERATOR_KEY);
  });
});

describe("the operator's key (key mode managed)", () => {
  // #276-T02
  it("is the key of the job, with the source operator, and the instance's default model", () => {
    const result = resolveWorkspaceLlmAccess({
      keyMode: "managed",
      operatorKey: { state: "key", apiKey: OPERATOR_KEY },
      defaults: { model: "vendor/default-model", contextWindowTokens: 50_000 },
    });

    expect(result).toMatchObject({
      ok: true,
      source: "operator",
      access: {
        provider: "openrouter",
        model: "vendor/default-model",
        apiKey: OPERATOR_KEY,
        contextWindowTokens: 50_000,
      },
    });
  });

  // #276-T03
  it("fails closed with operator_key_missing when the operator has no key", () => {
    expect(resolveWorkspaceLlmAccess(managed())).toEqual({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "operator_key_missing",
      issues: [],
    });
  });

  // #276-T04
  it("fails closed with operator_key_unreadable when the operator's key cannot be read", () => {
    expect(
      resolveWorkspaceLlmAccess(managed({ state: "unreadable" })),
    ).toMatchObject({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "operator_key_unreadable",
    });
  });

  // #276-T05
  it("never takes the operator's key for a workspace that is not managed, even without a key of its own", () => {
    // `own` has no input for the operator's key at all: the shape makes borrowing impossible.
    expect(resolveWorkspaceLlmAccess(own())).toMatchObject({
      ok: false,
      reason: "no_key",
    });
  });

  // #276-T05
  it("fails closed when the entitlements of the workspace cannot be read, so it is not known whose key applies", () => {
    expect(
      resolveWorkspaceLlmAccess({ keyMode: "unreadable", defaults: DEFAULTS }),
    ).toEqual({
      ok: false,
      errorCode: "llm_not_configured",
      reason: ENTITLEMENTS_INVALID_CODE,
      issues: [],
    });
  });
});

describe("the key mode of a job, from the entitlements of its workspace", () => {
  const limits = {
    diffRunsPerPeriod: null,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: null,
    ownKeyCostLimitMicroUsd: null,
  };
  const entitlements = (keyMode: "own" | "managed") =>
    ({
      kind: "limited",
      source: "workspace",
      planLabel: "plan",
      keyMode,
      limits,
      periodStart: "2026-10-01T00:00:00.000Z",
      suspended: false,
      suspensionCode: null,
    }) as const;

  // #276-T01
  // #276-T05
  it("is own without entitlements and with the key mode own", () => {
    expect(keyModeForJob({ kind: "unlimited" })).toBe("own");
    expect(keyModeForJob(entitlements("own"))).toBe("own");
  });

  // #276-T02
  it("is managed only when the entitlements say so", () => {
    expect(keyModeForJob(entitlements("managed"))).toBe("managed");
  });

  // #276-T05
  it("is unreadable for entitlements that cannot be read, never own", () => {
    expect(
      keyModeForJob({
        kind: "invalid",
        code: ENTITLEMENTS_INVALID_CODE,
        source: "workspace",
      }),
    ).toBe("unreadable");
  });
});
