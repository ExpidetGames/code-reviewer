// SPDX-License-Identifier: Apache-2.0

// Whose LLM key a job gets, assembled over a real database (src/llm/assemble.ts): the entitlements of the
// workspace (or the instance default) decide, the operator's key serves `managed` workspaces only, and every
// failure is closed (docs/decisions/0001-editions-setup-and-accounts.md, section 2.8, addendum).
import type { KyselyPlugin } from "kysely";
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createSecretStore } from "../secrets/store.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import type { EntitlementsData } from "../workspaces/entitlements.ts";
import { createWorkspaceLlm } from "./assemble.ts";
import {
  FAKE_PROVIDER_ID,
  createFakeAdapter,
} from "./providers/fake-adapter.ts";
import { openrouterDescriptor } from "./providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "./providers/registry.ts";

const APP_SECRET = "operator-access-test-app-secret-0123456789-0";
const WORKSPACE_KEY = "sk-or-v1-workspace-key-0000000000000000";
const OPERATOR_KEY = "sk-or-v1-operator-key-1111111111111111";
const FAKE_OPERATOR_KEY = "fk-live-operator-2222222222222222";
const FAKE_WORKSPACE_KEY = "fk-live-workspace-3333333333333333";
const ENV = { LLM_MODEL: "vendor/instance-model", LLM_MAX_TOKENS: "64000" };

function entitlements(
  keyMode: "own" | "managed",
  overrides: Partial<EntitlementsData> = {},
): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
    ...overrides,
  };
}

async function start(
  options: {
    appSecret?: () => string;
    providers?: Parameters<typeof createWorkspaceLlm>[0]["providers"];
  } = {},
) {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "alpha");
  // Every statement the assembly makes, as text, to see which tables a call touched.
  const statements: string[] = [];
  // Secret names whose read fails like a database that stops answering (set by `failReadOf`).
  const failing: string[] = [];
  const recorder: KyselyPlugin = {
    transformQuery: ({ node }) => {
      const text = JSON.stringify(node);
      if (failing.some((name) => text.includes(`"${name}"`)))
        throw new Error("the read of a stored secret failed");
      statements.push(text);
      return node;
    },
    transformResult: (args) => Promise.resolve(args.result),
  };
  const llm = createWorkspaceLlm({
    db: db.withPlugin(recorder),
    appSecret: options.appSecret ?? (() => APP_SECRET),
    env: () => ENV,
    ...(options.providers === undefined
      ? {}
      : { providers: options.providers }),
  });
  return {
    db,
    workspaceId,
    llm,
    /** Whether a statement since the last call read or wrote the table `secrets` (the instance's secrets). */
    touchedInstanceSecrets() {
      const touched = statements.some((text) =>
        text.includes('"name":"secrets"'),
      );
      statements.length = 0;
      return touched;
    },
    /** From now on, any statement that names this stored secret throws. */
    failReadOf(name: string) {
      failing.push(name);
    },
    async setWorkspaceKey(key = WORKSPACE_KEY, id = workspaceId) {
      const saved = await llm
        .keyServiceFor(id)
        .save({ provider: "openrouter", apiKey: key }, null);
      expect(saved.ok).toBe(true);
    },
    async setOperatorKey(key = OPERATOR_KEY) {
      const saved = await llm
        .operatorKey()
        .save({ provider: "openrouter", apiKey: key }, null);
      expect(saved.ok).toBe(true);
    },
    async setOperatorKeyOf(provider: string, key: string) {
      const saved = await llm
        .operatorKey()
        .save({ provider, apiKey: key }, null);
      expect(saved.ok).toBe(true);
    },
    setEntitlements: (data: EntitlementsData, id = workspaceId) =>
      createWorkspaceEntitlementsRepository(db, id).put(data, null),
  };
}

describe("a workspace without entitlements, or with the key mode own", () => {
  // #276-T01
  it("uses its own key and never reads the operator's key", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    t.touchedInstanceSecrets();

    const result = await t.llm.accessFor(t.workspaceId);

    expect(result).toMatchObject({
      ok: true,
      source: "workspace",
      access: { apiKey: WORKSPACE_KEY, model: "vendor/instance-model" },
    });
    expect(t.touchedInstanceSecrets()).toBe(false);
    expect(await t.llm.summaryFor(t.workspaceId)).toEqual({
      configured: true,
      source: "workspace",
    });
  });

  // #276-T05
  it("does not use the operator's key for the key mode own, with its own key missing", async () => {
    const t = await start();
    await t.setOperatorKey();
    await t.setEntitlements(entitlements("own"));

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "no_key",
    });
  });

  // #276-T05
  it("does not use the operator's key for a workspace with no entitlements at all, with its own key missing", async () => {
    const t = await start();
    await t.setOperatorKey();

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: false,
      reason: "no_key",
    });
  });

  // #276-T05
  it("does not use the operator's key for an unlimited instance default either", async () => {
    const t = await start();
    await t.setOperatorKey();
    await createInstanceSettingsRepository(t.db).set(
      "default_entitlements",
      entitlements("own", {
        limits: {
          diffRunsPerPeriod: 5,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
      }),
      null,
    );

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: false,
      reason: "no_key",
    });
  });

  // #276-T01
  it("masks only its own key", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setOperatorKey();

    expect(await t.llm.currentKeysFor(t.workspaceId)).toEqual([WORKSPACE_KEY]);
  });
});

describe("a workspace with the key mode managed", () => {
  // #276-T02
  it("uses the operator's key, with the source operator, though it has a key of its own", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.setEntitlements(entitlements("managed"));

    const result = await t.llm.accessFor(t.workspaceId);

    expect(result).toMatchObject({
      ok: true,
      source: "operator",
      access: {
        provider: "openrouter",
        apiKey: OPERATOR_KEY,
        model: "vendor/instance-model",
        contextWindowTokens: 64000,
      },
    });
    expect(JSON.stringify(result)).not.toContain(OPERATOR_KEY);
    expect(await t.llm.summaryFor(t.workspaceId)).toEqual({
      configured: true,
      source: "operator",
    });
  });

  // #276-T02
  it("keeps the workspace's own key stored, untouched", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.setEntitlements(entitlements("managed"));

    await t.llm.accessFor(t.workspaceId);

    expect(
      await t.llm.keyServiceFor(t.workspaceId).status("openrouter"),
    ).toMatchObject({
      state: "configured",
    });
    expect(
      await t.llm.keyServiceFor(t.workspaceId).keyFor("openrouter"),
    ).toMatchObject({
      state: "key",
      apiKey: WORKSPACE_KEY,
    });
  });

  // #276-T02
  it("uses the operator's key without a key of its own, and a key of its own that cannot be read is ignored", async () => {
    const t = await start();
    await t.setOperatorKey();
    await t.setEntitlements(entitlements("managed"));
    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "operator",
    });

    await t.setWorkspaceKey();
    await t.db
      .updateTable("workspace_secrets")
      .set({ nonce: "AAAA" })
      .execute();
    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "operator",
      access: { apiKey: OPERATOR_KEY },
    });
  });

  // #276-T02
  it("is managed by the instance default too, until a workspace has an entitlement of its own", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await createInstanceSettingsRepository(t.db).set(
      "default_entitlements",
      entitlements("managed"),
      null,
    );
    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "operator",
    });

    await t.setEntitlements(entitlements("own"));

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "workspace",
      access: { apiKey: WORKSPACE_KEY },
    });
  });

  // #276-T03
  it("fails closed with operator_key_missing when the operator stored no key, and never uses the workspace's", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setEntitlements(entitlements("managed"));

    const result = await t.llm.accessFor(t.workspaceId);

    expect(result).toEqual({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "operator_key_missing",
      issues: [],
    });
    expect(JSON.stringify(result)).not.toContain(WORKSPACE_KEY);
    expect(await t.llm.summaryFor(t.workspaceId)).toEqual({
      configured: false,
      reason: "operator_key_missing",
    });
  });

  // #276-T04
  it("fails closed with operator_key_unreadable when another APP_SECRET sealed the operator's key", async () => {
    const t = await start({
      appSecret: () => "a-different-app-secret-0123456789-0123456",
    });
    await createSecretStore({ db: t.db, appSecret: APP_SECRET }).save(
      "operator_llm_key",
      OPERATOR_KEY,
      { updatedBy: null },
    );
    await t.setEntitlements(entitlements("managed"));
    await t.setWorkspaceKey();

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "operator_key_unreadable",
    });
  });

  // #276-T05
  it("fails closed when its entitlements cannot be read, instead of choosing a key", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.setEntitlements(entitlements("managed"));
    await t.db
      .updateTable("workspace_entitlements")
      .set({ limits: "not json" })
      .execute();

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "entitlements_invalid",
    });
  });

  // #276-T02
  it("is decided for each workspace on its own entitlements", async () => {
    const t = await start();
    const other = await addWorkspace(t.db, "bravo");
    await t.setWorkspaceKey(WORKSPACE_KEY);
    await t.setWorkspaceKey("sk-or-v1-bravo-key-2222222222222222", other);
    await t.setOperatorKey();
    await t.setEntitlements(entitlements("managed"));

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      source: "operator",
    });
    expect(await t.llm.accessFor(other)).toMatchObject({
      source: "workspace",
      access: { apiKey: "sk-or-v1-bravo-key-2222222222222222" },
    });
  });

  // #276-T08
  it("masks the operator's key and the key of the workspace in its results", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.setEntitlements(entitlements("managed"));

    expect(await t.llm.currentKeysFor(t.workspaceId)).toEqual([
      WORKSPACE_KEY,
      OPERATOR_KEY,
    ]);
  });

  // #276-T08
  it("masks only what exists: no operator key to mask when the operator stored none", async () => {
    const t = await start();
    await t.setEntitlements(entitlements("managed"));

    expect(await t.llm.currentKeysFor(t.workspaceId)).toEqual([]);
  });
});

describe("a workspace with the key mode managed and several providers", () => {
  const providers = createProviderRegistry([
    openrouterDescriptor,
    createFakeAdapter(),
  ]);

  // #427-T05
  it("fails closed when the read of the operator's key of one provider fails: the masking list is not returned with fewer keys", async () => {
    const t = await start({ providers });
    await t.setOperatorKeyOf("openrouter", OPERATOR_KEY);
    await t.setOperatorKeyOf(FAKE_PROVIDER_ID, FAKE_OPERATOR_KEY);
    await t.setEntitlements(entitlements("managed"));
    expect(await t.llm.currentKeysFor(t.workspaceId)).toEqual([
      OPERATOR_KEY,
      FAKE_OPERATOR_KEY,
    ]);

    t.failReadOf(`operator_llm_key.${FAKE_PROVIDER_ID}`);

    await expect(t.llm.currentKeysFor(t.workspaceId)).rejects.toThrow(
      "the read of a stored secret failed",
    );
  });

  // #427-T04
  it("fails closed with operator_key_missing for a provider without an operator key, though another provider has one", async () => {
    const t = await start({ providers });
    await t.setOperatorKeyOf("openrouter", OPERATOR_KEY);
    await t.setEntitlements(entitlements("managed"));

    const result = await t.llm.accessFor(t.workspaceId, FAKE_PROVIDER_ID);

    expect(result).toEqual({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "operator_key_missing",
      issues: [],
    });
    expect(JSON.stringify(result)).not.toContain(OPERATOR_KEY);
    expect(await t.llm.summaryFor(t.workspaceId, FAKE_PROVIDER_ID)).toEqual({
      configured: false,
      reason: "operator_key_missing",
    });
  });

  // #427-T04
  it("uses the key of the provider of the job and never the key of the other one, in both directions", async () => {
    const t = await start({ providers });
    await t.setOperatorKeyOf("openrouter", OPERATOR_KEY);
    await t.setOperatorKeyOf(FAKE_PROVIDER_ID, FAKE_OPERATOR_KEY);
    await t.setEntitlements(entitlements("managed"));

    expect(await t.llm.accessFor(t.workspaceId, "openrouter")).toMatchObject({
      ok: true,
      source: "operator",
      access: { provider: "openrouter", apiKey: OPERATOR_KEY },
    });
    expect(
      await t.llm.accessFor(t.workspaceId, FAKE_PROVIDER_ID),
    ).toMatchObject({
      ok: true,
      source: "operator",
      access: { provider: FAKE_PROVIDER_ID, apiKey: FAKE_OPERATOR_KEY },
    });
    // Without a provider, the default provider's key.
    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      access: { provider: "openrouter", apiKey: OPERATOR_KEY },
    });
  });

  // #427-T04
  it("fails closed for a provider whose key is missing even when the workspace has a key of its own for it", async () => {
    const t = await start({ providers });
    await t.setOperatorKeyOf("openrouter", OPERATOR_KEY);
    await t.llm
      .keyServiceFor(t.workspaceId)
      .save({ provider: FAKE_PROVIDER_ID, apiKey: FAKE_WORKSPACE_KEY }, null);
    await t.setEntitlements(entitlements("managed"));

    const result = await t.llm.accessFor(t.workspaceId, FAKE_PROVIDER_ID);

    expect(result).toMatchObject({ ok: false, reason: "operator_key_missing" });
    expect(JSON.stringify(result)).not.toContain(FAKE_WORKSPACE_KEY);
  });

  // #427-T05
  it("masks the operator's key of every provider while the workspace is managed, and none of them otherwise", async () => {
    const t = await start({ providers });
    await t.setOperatorKeyOf("openrouter", OPERATOR_KEY);
    await t.setOperatorKeyOf(FAKE_PROVIDER_ID, FAKE_OPERATOR_KEY);
    await t.llm
      .keyServiceFor(t.workspaceId)
      .save({ provider: FAKE_PROVIDER_ID, apiKey: FAKE_WORKSPACE_KEY }, null);

    await t.setEntitlements(entitlements("own"));
    expect(await t.llm.currentKeysFor(t.workspaceId)).toEqual([
      FAKE_WORKSPACE_KEY,
    ]);

    await t.setEntitlements(entitlements("managed"));
    expect(await t.llm.currentKeysFor(t.workspaceId)).toEqual([
      FAKE_WORKSPACE_KEY,
      OPERATOR_KEY,
      FAKE_OPERATOR_KEY,
    ]);
  });
});
