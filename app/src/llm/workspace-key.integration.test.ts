// SPDX-License-Identifier: LicenseRef-Proprietary

// The LLM key of a workspace over a real Postgres database: what a save accepts and refuses (the same rules as the
// legacy variable), that an empty field keeps the stored key of that provider, that the
// answers carry no key, and that the stored value is encrypted.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createWorkspaceSecretStore } from "../secrets/workspace-store.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createWorkspaceLlmKeyService } from "./workspace-key.ts";

const APP_SECRET = "llm-key-test-app-secret-0123456789-012345";
const KEY = "sk-or-v1-dummy-0123456789abcdef0123456789abcdef";
const OTHER_KEY = "sk-or-v1-dummy-fedcba9876543210fedcba9876543210";

async function start() {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "alpha");
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('admin-1', 'Admin', 'admin@example.test', 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`.execute(
    db,
  );
  const store = createWorkspaceSecretStore({
    db,
    workspaceId,
    appSecret: APP_SECRET,
  });
  return {
    db,
    store,
    service: createWorkspaceLlmKeyService({ store }),
  };
}

describe("saving the key of a workspace", () => {
  // #104-LK-03
  it("stores the key encrypted and answers with whether it is configured and its last four characters only", async () => {
    const { db, service } = await start();

    const saved = await service.save(
      { provider: "openrouter", apiKey: KEY },
      "admin-1",
    );

    expect(saved).toEqual({
      ok: true,
      changed: true,
      status: {
        state: "configured",
        provider: "openrouter",
        lastFour: KEY.slice(-4),
        updatedAt: expect.any(String),
        updatedBy: "admin-1",
      },
    });
    expect(JSON.stringify(saved)).not.toContain(KEY.slice(0, -4));
    const stored = await db
      .selectFrom("workspace_secrets")
      .selectAll()
      .execute();
    expect(JSON.stringify(stored)).not.toContain(KEY.slice(0, -4));
    expect(stored).toHaveLength(1);
  });

  // #104-LK-02
  it("ignores whitespace around the key and a trailing line break", async () => {
    const { service } = await start();

    await service.save(
      { provider: "openrouter", apiKey: ` ${KEY}\n` },
      "admin-1",
    );

    const revealed = await service.reveal("openrouter");
    expect(revealed.ok && revealed.apiKey.reveal()).toBe(KEY);
  });

  // #104-LK-02
  it.each([
    ["whitespace inside", "sk-or-v1 0123456789"],
    ["a tab inside", "sk-or-v1\t0123456789"],
    ["a control character inside", "sk-or-v1\u0007abcdef"],
    ["more than 4096 characters", "k".repeat(4097)],
    ["not text", 12345],
    ["an object", { key: KEY }],
  ])("refuses a key with %s and stores nothing", async (_, apiKey) => {
    const { service } = await start();

    const result = await service.save(
      { provider: "openrouter", apiKey },
      "admin-1",
    );

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "apiKey", code: "api_key_invalid" }],
    });
    expect(await service.status("openrouter")).toEqual({
      state: "not_configured",
    });
  });

  // #104-LK-02
  it("accepts a key of exactly 4096 characters", async () => {
    const { service } = await start();

    const result = await service.save(
      { provider: "openrouter", apiKey: "k".repeat(4096) },
      "admin-1",
    );

    expect(result.ok).toBe(true);
  });

  it.each([["unknown"], [""], [undefined], [null], [42]])(
    "refuses the provider %j",
    async (provider) => {
      const { service } = await start();

      const result = await service.save({ provider, apiKey: KEY }, "admin-1");

      expect(result).toEqual({
        ok: false,
        issues: [{ field: "provider", code: "provider_invalid" }],
      });
    },
  );

  it("accepts the provider in any case", async () => {
    const { service } = await start();

    const result = await service.save(
      { provider: " OpenRouter ", apiKey: KEY },
      "admin-1",
    );

    expect(result.ok && result.status).toMatchObject({
      provider: "openrouter",
    });
  });

  it("does not show the last four characters of a short key", async () => {
    const { service } = await start();

    await service.save(
      { provider: "openrouter", apiKey: "short-key-1" },
      "admin-1",
    );

    expect(await service.status("openrouter")).toMatchObject({
      state: "configured",
      lastFour: null,
    });
  });
});

describe("an empty field", () => {
  // #104-LK-03
  it("keeps the stored key", async () => {
    const { service } = await start();
    await service.save({ provider: "openrouter", apiKey: KEY }, "admin-1");

    for (const apiKey of [undefined, null, "", "   "]) {
      const result = await service.save(
        { provider: "openrouter", apiKey },
        "admin-1",
      );
      expect(result).toMatchObject({ ok: true, changed: false });
    }

    const revealed = await service.reveal("openrouter");
    expect(revealed.ok && revealed.apiKey.reveal()).toBe(KEY);
  });

  it("is refused when there is no key to keep", async () => {
    const { service } = await start();

    const result = await service.save(
      { provider: "openrouter", apiKey: "" },
      "admin-1",
    );

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "apiKey", code: "api_key_required" }],
    });
  });

  it("is refused when the stored key cannot be read, because there is nothing to keep", async () => {
    const { db, service } = await start();
    await service.save({ provider: "openrouter", apiKey: KEY }, "admin-1");
    await db
      .updateTable("workspace_secrets")
      .set({ ciphertext: "AAAA" })
      .execute();

    const result = await service.save(
      { provider: "openrouter", apiKey: "" },
      "admin-1",
    );

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "apiKey", code: "api_key_required" }],
    });
  });

  // #104-LK-03 (the lesson of #100: a stored secret is never carried to another provider or endpoint)
  // #426-T01
  it("does not reveal a key that was entered for another provider than the one of its slot", async () => {
    const { db, service } = await start();
    await service.save({ provider: "openrouter", apiKey: KEY }, "admin-1");
    // A key that was entered for another provider (a later version, or an edited row).
    await db
      .updateTable("workspace_secrets")
      .set({ binding: "another-provider" })
      .execute();

    // It is not revealed for the provider (the test button); the resolver compares the binding, so it is handed
    // over as stored.
    expect(await service.reveal("openrouter")).toEqual({
      ok: false,
      reason: "key_binding_mismatch",
    });
    expect((await service.keyFor("openrouter")).state).toBe("key");
    expect(await service.status("openrouter")).toMatchObject({
      provider: "another-provider",
    });
  });

  it("replaces the key when a new one is entered", async () => {
    const { service } = await start();
    await service.save({ provider: "openrouter", apiKey: KEY }, "admin-1");

    await service.save(
      { provider: "openrouter", apiKey: OTHER_KEY },
      "admin-1",
    );

    const revealed = await service.reveal("openrouter");
    expect(revealed.ok && revealed.apiKey.reveal()).toBe(OTHER_KEY);
    expect(await service.status("openrouter")).toMatchObject({
      lastFour: OTHER_KEY.slice(-4),
    });
  });
});

describe("removing the key", () => {
  // #104-LK-08
  it("leaves the workspace without a key", async () => {
    const { service } = await start();
    await service.save({ provider: "openrouter", apiKey: KEY }, "admin-1");

    expect(await service.remove("openrouter")).toBe(true);

    expect(await service.status("openrouter")).toEqual({
      state: "not_configured",
    });
    expect(await service.keyFor("openrouter")).toEqual({ state: "none" });
    expect(await service.remove("openrouter")).toBe(false);
  });
});

describe("a key that was entered for another provider", () => {
  // #104-LK-09 (the test button must not send it to the provider either)
  it("is not revealed for the test button, and is not used for a job", async () => {
    const { db, service } = await start();
    await service.save({ provider: "openrouter", apiKey: KEY }, "admin-1");
    await db
      .updateTable("workspace_secrets")
      .set({ binding: "another-provider" })
      .execute();

    expect(await service.reveal("openrouter")).toEqual({
      ok: false,
      reason: "key_binding_mismatch",
    });
    expect(await service.keyFor("openrouter")).toMatchObject({
      state: "key",
      binding: "another-provider",
    });
  });
});

describe("a key that cannot be read", () => {
  it("is reported as unreadable, never as a key, and never throws", async () => {
    const { db, service } = await start();
    await service.save({ provider: "openrouter", apiKey: KEY }, "admin-1");
    await db.updateTable("workspace_secrets").set({ nonce: "AAAA" }).execute();

    expect(await service.status("openrouter")).toMatchObject({
      state: "unreadable",
      provider: "openrouter",
    });
    expect(await service.keyFor("openrouter")).toEqual({ state: "unreadable" });
    expect(await service.reveal("openrouter")).toEqual({
      ok: false,
      reason: "key_unreadable",
    });
  });
});
