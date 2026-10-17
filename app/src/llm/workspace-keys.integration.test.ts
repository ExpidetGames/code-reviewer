// SPDX-License-Identifier: Apache-2.0

// One key per provider in the same workspace (#426, ADR 0005 section 2.5): over a real SQLite file, with a registry
// that has a second provider which exists only in tests. The OpenRouter key keeps the name it has always had.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createWorkspaceSecretStore } from "../secrets/workspace-store.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import {
  FAKE_PROVIDER_ID,
  createFakeAdapter,
} from "./providers/fake-adapter.ts";
import { openrouterDescriptor } from "./providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "./providers/registry.ts";
import { createWorkspaceLlmKeyService } from "./workspace-key.ts";

const APP_SECRET = "llm-keys-test-app-secret-0123456789-012345";
const OPENROUTER_KEY = "sk-or-v1-dummy-0123456789abcdef0123456789abcdef";
const OPENROUTER_OTHER_KEY = "sk-or-v1-dummy-fedcba9876543210fedcba9876543210";
const FAKE_KEY = "fk-live-dummy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FAKE_OTHER_KEY = "fk-live-dummy-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const providers = createProviderRegistry([
  openrouterDescriptor,
  createFakeAdapter(),
]);

async function start() {
  const { db } = await createTestDatabase();
  const alpha = await addWorkspace(db, "alpha");
  const beta = await addWorkspace(db, "beta");
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('admin-1', 'Admin', 'admin@example.test', 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`.execute(
    db,
  );
  const storeOf = (workspaceId: string) =>
    createWorkspaceSecretStore({ db, workspaceId, appSecret: APP_SECRET });
  const serviceOf = (workspaceId: string) =>
    createWorkspaceLlmKeyService({ store: storeOf(workspaceId), providers });
  return {
    db,
    alpha,
    beta,
    storeOf,
    service: serviceOf(alpha),
    serviceOf,
  };
}

describe("a key for each provider of a workspace", () => {
  // #426-T01
  it("saves, replaces and removes the key of one provider and leaves the other provider's key untouched", async () => {
    const { service, db } = await start();

    await service.save(
      { provider: "openrouter", apiKey: OPENROUTER_KEY },
      "admin-1",
    );
    await service.save(
      { provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY },
      "admin-1",
    );
    const replaced = await service.save(
      { provider: FAKE_PROVIDER_ID, apiKey: FAKE_OTHER_KEY },
      "admin-1",
    );

    expect(replaced).toMatchObject({
      ok: true,
      changed: true,
      status: { state: "configured", provider: FAKE_PROVIDER_ID },
    });
    const openrouter = await service.reveal("openrouter");
    expect(openrouter.ok && openrouter.apiKey.reveal()).toBe(OPENROUTER_KEY);
    const fake = await service.reveal(FAKE_PROVIDER_ID);
    expect(fake.ok && fake.apiKey.reveal()).toBe(FAKE_OTHER_KEY);
    const names = await db
      .selectFrom("workspace_secrets")
      .select("name")
      .orderBy("name")
      .execute();
    expect(names.map((row) => row.name)).toEqual([
      "llm_api_key",
      `llm_api_key.${FAKE_PROVIDER_ID}`,
    ]);

    expect(await service.remove(FAKE_PROVIDER_ID)).toBe(true);

    expect(await service.status(FAKE_PROVIDER_ID)).toEqual({
      state: "not_configured",
    });
    expect(await service.remove(FAKE_PROVIDER_ID)).toBe(false);
    expect(await service.status("openrouter")).toMatchObject({
      state: "configured",
      provider: "openrouter",
    });
    const stillThere = await service.reveal("openrouter");
    expect(stillThere.ok && stillThere.apiKey.reveal()).toBe(OPENROUTER_KEY);

    expect(await service.remove("openrouter")).toBe(true);
    expect(await service.remove("openrouter")).toBe(false);
  });

  // #426-T01
  it("lists the state of every registered provider, with the providers that have no key", async () => {
    const { service } = await start();
    await service.save(
      { provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY },
      "admin-1",
    );

    const all = await service.statusAll();

    expect(all.map((entry) => entry.provider)).toEqual([
      "openrouter",
      FAKE_PROVIDER_ID,
    ]);
    expect(all[0]?.status).toEqual({ state: "not_configured" });
    expect(all[1]?.status).toMatchObject({
      state: "configured",
      provider: FAKE_PROVIDER_ID,
      lastFour: FAKE_KEY.slice(-4),
    });
  });

  // #426-T01
  it("keeps the empty field for the provider that has a key and refuses it for the one that has none", async () => {
    const { service } = await start();
    await service.save(
      { provider: "openrouter", apiKey: OPENROUTER_KEY },
      "admin-1",
    );

    const kept = await service.save(
      { provider: "openrouter", apiKey: "" },
      "admin-1",
    );
    const refused = await service.save(
      { provider: FAKE_PROVIDER_ID, apiKey: "" },
      "admin-1",
    );

    expect(kept).toMatchObject({ ok: true, changed: false });
    expect(refused).toEqual({
      ok: false,
      issues: [{ field: "apiKey", code: "api_key_required" }],
    });
  });

  // #426-T01
  it("hands a job the key of the provider it asks for and of no other", async () => {
    const { service } = await start();
    await service.save(
      { provider: "openrouter", apiKey: OPENROUTER_KEY },
      "admin-1",
    );

    expect(await service.keyFor("openrouter")).toEqual({
      state: "key",
      binding: "openrouter",
      apiKey: OPENROUTER_KEY,
    });
    expect(await service.keyFor(FAKE_PROVIDER_ID)).toEqual({ state: "none" });
    expect(await service.keyFor("not-a-provider")).toEqual({ state: "none" });
  });

  // #426-T01
  it("refuses a provider that is not registered", async () => {
    const { service } = await start();

    const result = await service.save(
      { provider: "elsewhere", apiKey: OPENROUTER_KEY },
      "admin-1",
    );

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "provider", code: "provider_invalid" }],
    });
  });
});

describe("a stored key and the name it is bound to", () => {
  // #426-T02
  it("does not decrypt as the key of another provider of the same workspace", async () => {
    const { service, db, alpha } = await start();
    await service.save(
      { provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY },
      "admin-1",
    );
    // The ciphertext of the fake provider's key, put under the name of OpenRouter's key.
    await db
      .updateTable("workspace_secrets")
      .set({ name: "llm_api_key", binding: "openrouter" })
      .where("workspace_id", "=", alpha)
      .execute();

    expect(await service.keyFor("openrouter")).toEqual({ state: "unreadable" });
    expect(await service.status("openrouter")).toMatchObject({
      state: "unreadable",
    });
    expect(await service.reveal("openrouter")).toEqual({
      ok: false,
      reason: "key_unreadable",
    });
  });

  // #426-T02
  it("does not decrypt in another workspace", async () => {
    const { service, serviceOf, db, alpha, beta } = await start();
    await service.save(
      { provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY },
      "admin-1",
    );
    await sql`insert into workspace_secrets
      (workspace_id, name, binding, ciphertext, nonce, key_version, last_four, updated_by, updated_at)
      select ${beta}, name, binding, ciphertext, nonce, key_version, last_four, updated_by, updated_at
      from workspace_secrets where workspace_id = ${alpha}`.execute(db);

    expect(await serviceOf(beta).keyFor(FAKE_PROVIDER_ID)).toEqual({
      state: "unreadable",
    });
    expect(await serviceOf(beta).reveal(FAKE_PROVIDER_ID)).toEqual({
      ok: false,
      reason: "key_unreadable",
    });
  });

  // #426-T02
  it("does not give a key to the provider named by another binding", async () => {
    const { service, db } = await start();
    await service.save(
      { provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY },
      "admin-1",
    );
    await db
      .updateTable("workspace_secrets")
      .set({ binding: "openrouter" })
      .execute();

    expect(await service.reveal(FAKE_PROVIDER_ID)).toEqual({
      ok: false,
      reason: "key_binding_mismatch",
    });
  });
});

describe("a row that was stored before there were several providers", () => {
  // #426-T03
  it("reads as the OpenRouter key, with no migration", async () => {
    const { service, storeOf, alpha } = await start();
    // Exactly what the single-slot service wrote: the name `llm_api_key` and the binding `openrouter`.
    await storeOf(alpha).save("llm_api_key", OPENROUTER_KEY, {
      binding: "openrouter",
      updatedBy: "admin-1",
      showLastFour: true,
    });

    expect(await service.status("openrouter")).toMatchObject({
      state: "configured",
      provider: "openrouter",
      lastFour: OPENROUTER_KEY.slice(-4),
      updatedBy: "admin-1",
    });
    expect(await service.keyFor("openrouter")).toEqual({
      state: "key",
      binding: "openrouter",
      apiKey: OPENROUTER_KEY,
    });
    expect(await service.status(FAKE_PROVIDER_ID)).toEqual({
      state: "not_configured",
    });
    // Replacing it writes the same row.
    await service.save(
      { provider: "openrouter", apiKey: OPENROUTER_OTHER_KEY },
      "admin-1",
    );
    const revealed = await service.reveal("openrouter");
    expect(revealed.ok && revealed.apiKey.reveal()).toBe(OPENROUTER_OTHER_KEY);
  });
});

describe("what the service lets out", () => {
  // #426-T05
  it("holds no key in the state of any provider, the answer of a save or an error", async () => {
    const { service } = await start();
    const saved = await service.save(
      { provider: "openrouter", apiKey: OPENROUTER_KEY },
      "admin-1",
    );
    await service.save(
      { provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY },
      "admin-1",
    );
    const refused = await service.save(
      { provider: FAKE_PROVIDER_ID, apiKey: "bad key" },
      "admin-1",
    );

    const shown = JSON.stringify([
      saved,
      refused,
      await service.statusAll(),
      await service.status("openrouter"),
    ]);

    for (const key of [OPENROUTER_KEY, FAKE_KEY])
      expect(shown).not.toContain(key.slice(0, -4));
  });
});
