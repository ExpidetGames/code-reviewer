// SPDX-License-Identifier: Apache-2.0

// #496: whose key a workspace's jobs get while billing is on, assembled over a real database (src/llm/assemble.ts). With billing
// off the entitlements decide, as ever; with billing on the choice of the workspace (default: our models) decides and the
// entitlement's key mode is not looked at. A choice of `own` without a stored key ends closed (`no_key`), never on our key.
import { describe, expect, it } from "vitest";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import type { EntitlementsData } from "../workspaces/entitlements.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import { createWorkspaceLlm } from "./assemble.ts";
import { createLlmKeyModeStore } from "./key-mode-store.ts";

const APP_SECRET = "key-mode-test-app-secret-0123456789-0123456";
const WORKSPACE_KEY = "sk-or-v1-workspace-key-0000000000000000";
const OPERATOR_KEY = "sk-or-v1-operator-key-1111111111111111";
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

async function start() {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "alpha");
  const llm = createWorkspaceLlm({
    db,
    appSecret: () => APP_SECRET,
    env: () => ENV,
  });
  return {
    db,
    workspaceId,
    llm,
    choose: (mode: "own" | "managed", id = workspaceId) =>
      createLlmKeyModeStore(db, id).set(mode, "someone"),
    chosen: (id = workspaceId) => createLlmKeyModeStore(db, id).get(),
    setEntitlements: (data: EntitlementsData) =>
      createWorkspaceEntitlementsRepository(db, workspaceId).put(data, null),
    async setWorkspaceKey() {
      const saved = await llm
        .keyServiceFor(workspaceId)
        .save({ provider: "openrouter", apiKey: WORKSPACE_KEY }, null);
      expect(saved.ok).toBe(true);
    },
    async setOperatorKey() {
      const saved = await llm
        .operatorKey()
        .save({ provider: "openrouter", apiKey: OPERATOR_KEY }, null);
      expect(saved.ok).toBe(true);
    },
  };
}

describe("the stored choice", () => {
  // #496-T07
  it("is a workspace setting: absent until chosen, kept per workspace, read back as it was saved", async () => {
    const t = await start();
    const other = await addWorkspace(t.db, "beta");

    expect(await t.chosen()).toBeUndefined();
    await t.choose("own");
    await t.choose("managed", other);

    expect(await t.chosen()).toBe("own");
    expect(await t.chosen(other)).toBe("managed");
  });

  // #496-T07
  it("reads as not chosen when the stored value is none of the two modes", async () => {
    const t = await start();
    await createAppSettingsRepository(t.db, t.workspaceId).set(
      "llm_key_mode",
      "free",
      null,
    );

    expect(await t.chosen()).toBeUndefined();
  });
});

describe("billing off", () => {
  // #496-T03
  it("leaves a workspace without entitlements on its own key, whatever it chose", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.choose("managed");

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "workspace",
      access: { apiKey: WORKSPACE_KEY },
    });
  });

  // #496-T03
  it("leaves a managed entitlement on the operator's key, whatever the workspace chose", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.setEntitlements(entitlements("managed"));
    await t.choose("own");

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "operator",
      access: { apiKey: OPERATOR_KEY },
    });
  });

  // #496-T03
  it("leaves an own entitlement on its own key, whatever the workspace chose", async () => {
    const t = await start();
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.setEntitlements(entitlements("own"));
    await t.choose("managed");

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "workspace",
    });
    expect(await readEffectiveEntitlements(t.db, t.workspaceId)).toMatchObject({
      kind: "limited",
      keyMode: "own",
    });
  });
});

describe("billing on", () => {
  // #496-T04
  it("runs a job on the workspace's own key when it chose its own key", async () => {
    const t = await start();
    await setBillingSwitch(t.db, true);
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.choose("own");

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "workspace",
      access: { apiKey: WORKSPACE_KEY },
    });
    expect(await t.llm.summaryFor(t.workspaceId)).toEqual({
      configured: true,
      source: "workspace",
    });
  });

  // #496-T05
  it("ends closed with no_key when it chose its own key and has none for the provider, never on our key", async () => {
    const t = await start();
    await setBillingSwitch(t.db, true);
    await t.setOperatorKey();
    await t.choose("own");

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: false,
      errorCode: "llm_not_configured",
      reason: "no_key",
    });
    expect(
      await t.llm.keyFor(t.workspaceId, {
        keyMode: "own",
        provider: "openrouter",
      }),
    ).toMatchObject({ ok: false, reason: "no_key" });
  });

  // #496-T06
  it("uses the operator's key and never the stored own key when it chose our models", async () => {
    const t = await start();
    await setBillingSwitch(t.db, true);
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.choose("managed");

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "operator",
      access: { apiKey: OPERATOR_KEY },
    });
  });

  // #496-T02
  it("defaults to our models for a workspace that has not chosen, with or without entitlements", async () => {
    const t = await start();
    await setBillingSwitch(t.db, true);
    await t.setWorkspaceKey();
    await t.setOperatorKey();

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "operator",
    });

    await t.setEntitlements(entitlements("own"));
    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "operator",
    });
  });

  // #496-T02
  it("does not consult the key mode of the entitlements, the row's or the instance default's", async () => {
    const t = await start();
    await setBillingSwitch(t.db, true);
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.setEntitlements(entitlements("managed"));
    await t.choose("own");

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: true,
      source: "workspace",
    });
  });

  // #496-T08
  it("still reads the rest of the entitlements: suspension, model access and cost limits", async () => {
    const t = await start();
    await setBillingSwitch(t.db, true);
    await t.setEntitlements(
      entitlements("managed", {
        suspended: true,
        suspensionCode: "unpaid",
        modelAccess: { catalogEntries: ["mce_entry1"] },
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: 1_000_000,
          ownKeyCostLimitMicroUsd: 2_000_000,
        },
      }),
    );
    await t.choose("own");

    expect(await readEffectiveEntitlements(t.db, t.workspaceId)).toMatchObject({
      kind: "limited",
      keyMode: "own",
      suspended: true,
      suspensionCode: "unpaid",
      modelAccess: { catalogEntries: ["mce_entry1"] },
      limits: {
        managedCostLimitMicroUsd: 1_000_000,
        ownKeyCostLimitMicroUsd: 2_000_000,
      },
    });
  });

  // #496-T08
  it("keeps entitlements that cannot be read unreadable and fails the access closed", async () => {
    const t = await start();
    await setBillingSwitch(t.db, true);
    await t.setOperatorKey();
    await t.choose("managed");
    await t.setEntitlements(entitlements("managed"));
    await t.db
      .updateTable("workspace_entitlements")
      .set({ limits: "not json" })
      .execute();

    expect(await t.llm.accessFor(t.workspaceId)).toMatchObject({
      ok: false,
      reason: "entitlements_invalid",
    });
  });

  // #496-T06
  it("masks the operator's key in a result even after the workspace switched to its own key", async () => {
    const t = await start();
    await setBillingSwitch(t.db, true);
    await t.setWorkspaceKey();
    await t.setOperatorKey();
    await t.choose("own");

    const keys = await t.llm.currentKeysFor(t.workspaceId);

    expect(keys).toContain(WORKSPACE_KEY);
    expect(keys).toContain(OPERATOR_KEY);
  });
});
