// SPDX-License-Identifier: Apache-2.0

// The operator's LLM key over a real SQLite file (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.8): what a save accepts and refuses (the rules of the workspace key), that the answers carry the status and the
// last four characters only, that the stored value is encrypted, and that a key another APP_SECRET sealed is
// reported as unreadable instead of being used.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createSecretStore } from "../secrets/store.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createOperatorLlmKeyService } from "./operator-key.ts";

const APP_SECRET = "operator-key-test-app-secret-0123456789-01";
const KEY = "sk-or-v1-operator-0123456789abcdef0123456789abcdef";
const OTHER_KEY = "sk-or-v1-operator-fedcba9876543210fedcba9876543210";

async function start() {
  const { db } = await createTestDatabase();
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('admin-1', 'Admin', 'admin@example.test', 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`.execute(
    db,
  );
  const store = createSecretStore({ db, appSecret: APP_SECRET });
  return { db, store, service: createOperatorLlmKeyService({ store }) };
}

describe("saving the operator's key", () => {
  // #276-T06
  it("stores the key encrypted and answers with the status and the last four characters only", async () => {
    const { db, service } = await start();

    const saved = await service.save({ apiKey: KEY }, "admin-1");

    expect(saved).toEqual({
      ok: true,
      status: {
        state: "configured",
        lastFour: KEY.slice(-4),
        updatedAt: expect.any(String),
        updatedBy: "admin-1",
      },
    });
    expect(JSON.stringify(saved)).not.toContain(KEY.slice(0, -4));
    const stored = await db.selectFrom("secrets").selectAll().execute();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe("operator_llm_key");
    expect(JSON.stringify(stored)).not.toContain(KEY.slice(0, -4));
    expect(await service.status()).toMatchObject({ state: "configured" });
  });

  // #276-T06
  it("ignores whitespace around the key and refuses whitespace inside, a missing key and an empty one", async () => {
    const { service } = await start();

    expect(await service.save({ apiKey: `  ${KEY}\n` }, null)).toMatchObject({
      ok: true,
    });
    expect(await service.forJob()).toEqual({ state: "key", apiKey: KEY });

    for (const apiKey of ["sk or v1", "sk-or\tv1", "x".repeat(4097), 42]) {
      expect(await service.save({ apiKey }, null)).toEqual({
        ok: false,
        issues: [{ field: "apiKey", code: "api_key_invalid" }],
      });
    }
    for (const apiKey of ["", "   ", undefined, null]) {
      expect(await service.save({ apiKey }, null)).toEqual({
        ok: false,
        issues: [{ field: "apiKey", code: "api_key_required" }],
      });
    }
    // Nothing a refusal did changed the stored key.
    expect(await service.forJob()).toEqual({ state: "key", apiKey: KEY });
  });

  // #276-T06
  it("replaces the key with a new one", async () => {
    const { service } = await start();
    await service.save({ apiKey: KEY }, "admin-1");

    await service.save({ apiKey: OTHER_KEY }, "admin-1");

    expect(await service.forJob()).toEqual({ state: "key", apiKey: OTHER_KEY });
    expect(await service.status()).toMatchObject({
      lastFour: OTHER_KEY.slice(-4),
    });
  });
});

describe("the operator's key as a job needs it", () => {
  it("is none until a key is saved, and none again after it is removed", async () => {
    const { service } = await start();
    expect(await service.forJob()).toEqual({ state: "none" });
    expect(await service.status()).toEqual({ state: "not_configured" });
    expect(await service.remove()).toBe(false);

    await service.save({ apiKey: KEY }, null);
    expect(await service.remove()).toBe(true);

    expect(await service.forJob()).toEqual({ state: "none" });
  });

  // #276-T04
  it("is unreadable when another APP_SECRET sealed it, and its status says so without the key", async () => {
    const { db, service } = await start();
    await service.save({ apiKey: KEY }, "admin-1");
    const other = createOperatorLlmKeyService({
      store: createSecretStore({
        db,
        appSecret: "another-app-secret-0123456789-0123456789-0",
      }),
    });

    expect(await other.forJob()).toEqual({ state: "unreadable" });
    const status = await other.status();
    expect(status).toMatchObject({ state: "unreadable" });
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("does not print the key when the answer is logged", async () => {
    const { service } = await start();
    await service.save({ apiKey: KEY }, null);

    const access = await service.forJob();

    // The resolver gets the plain value; nothing else of the service ever returns it.
    expect(access).toEqual({ state: "key", apiKey: KEY });
    expect(JSON.stringify(await service.status())).not.toContain(KEY);
  });
});
