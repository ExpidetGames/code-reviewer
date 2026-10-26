// SPDX-License-Identifier: LicenseRef-Proprietary

// The operator's LLM key over a real Postgres database (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.8): what a save accepts and refuses (the rules of the workspace key), that the answers carry the status and the
// last four characters only, that the stored value is encrypted, and that a key another APP_SECRET sealed is
// reported as unreadable instead of being used.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createSecretStore } from "../secrets/store.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createOperatorLlmKeyService } from "./operator-key.ts";
import { DEFAULT_LLM_PROVIDER } from "./providers/index.ts";
import {
  FAKE_PROVIDER_ID,
  createFakeAdapter,
} from "./providers/fake-adapter.ts";
import { openrouterDescriptor } from "./providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "./providers/registry.ts";

const OPENROUTER = DEFAULT_LLM_PROVIDER;
const FAKE_KEY = "fk-live-operator-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FAKE_OTHER_KEY = "fk-live-operator-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const providers = createProviderRegistry([
  openrouterDescriptor,
  createFakeAdapter(),
]);

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
  return {
    db,
    store,
    service: createOperatorLlmKeyService({ store, providers }),
  };
}

describe("saving the operator's key", () => {
  // #276-T06
  it("stores the key encrypted and answers with the status and the last four characters only", async () => {
    const { db, service } = await start();

    const saved = await service.save(
      { provider: OPENROUTER, apiKey: KEY },
      "admin-1",
    );

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
    expect(await service.status(OPENROUTER)).toMatchObject({
      state: "configured",
    });
  });

  // #276-T06
  it("ignores whitespace around the key and refuses whitespace inside, a missing key and an empty one", async () => {
    const { service } = await start();

    expect(
      await service.save({ provider: OPENROUTER, apiKey: `  ${KEY}\n` }, null),
    ).toMatchObject({
      ok: true,
    });
    expect(await service.forJob(OPENROUTER)).toEqual({
      state: "key",
      apiKey: KEY,
    });

    for (const apiKey of ["sk or v1", "sk-or\tv1", "x".repeat(4097), 42]) {
      expect(
        await service.save({ provider: OPENROUTER, apiKey }, null),
      ).toEqual({
        ok: false,
        issues: [{ field: "apiKey", code: "api_key_invalid" }],
      });
    }
    for (const apiKey of ["", "   ", undefined, null]) {
      expect(
        await service.save({ provider: OPENROUTER, apiKey }, null),
      ).toEqual({
        ok: false,
        issues: [{ field: "apiKey", code: "api_key_required" }],
      });
    }
    // Nothing a refusal did changed the stored key.
    expect(await service.forJob(OPENROUTER)).toEqual({
      state: "key",
      apiKey: KEY,
    });
  });

  // #276-T06
  it("replaces the key with a new one", async () => {
    const { service } = await start();
    await service.save({ provider: OPENROUTER, apiKey: KEY }, "admin-1");

    await service.save({ provider: OPENROUTER, apiKey: OTHER_KEY }, "admin-1");

    expect(await service.forJob(OPENROUTER)).toEqual({
      state: "key",
      apiKey: OTHER_KEY,
    });
    expect(await service.status(OPENROUTER)).toMatchObject({
      lastFour: OTHER_KEY.slice(-4),
    });
  });
});

describe("the operator's key as a job needs it", () => {
  it("is none until a key is saved, and none again after it is removed", async () => {
    const { service } = await start();
    expect(await service.forJob(OPENROUTER)).toEqual({ state: "none" });
    expect(await service.status(OPENROUTER)).toEqual({
      state: "not_configured",
    });
    expect(await service.remove(OPENROUTER)).toBe(false);

    await service.save({ provider: OPENROUTER, apiKey: KEY }, null);
    expect(await service.remove(OPENROUTER)).toBe(true);

    expect(await service.forJob(OPENROUTER)).toEqual({ state: "none" });
  });

  // #276-T04
  it("is unreadable when another APP_SECRET sealed it, and its status says so without the key", async () => {
    const { db, service } = await start();
    await service.save({ provider: OPENROUTER, apiKey: KEY }, "admin-1");
    const other = createOperatorLlmKeyService({
      store: createSecretStore({
        db,
        appSecret: "another-app-secret-0123456789-0123456789-0",
      }),
      providers,
    });

    expect(await other.forJob(OPENROUTER)).toEqual({ state: "unreadable" });
    const status = await other.status(OPENROUTER);
    expect(status).toMatchObject({ state: "unreadable" });
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("does not print the key when the answer is logged", async () => {
    const { service } = await start();
    await service.save({ provider: OPENROUTER, apiKey: KEY }, null);

    const access = await service.forJob(OPENROUTER);

    // The resolver gets the plain value; nothing else of the service ever returns it.
    expect(access).toEqual({ state: "key", apiKey: KEY });
    expect(JSON.stringify(await service.status(OPENROUTER))).not.toContain(KEY);
  });
});

describe("a key for each provider of the operator", () => {
  // #427-T01
  it("saves, replaces and removes the key of one provider and leaves the other provider's key untouched", async () => {
    const { service, db } = await start();

    await service.save({ provider: OPENROUTER, apiKey: KEY }, "admin-1");
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
      status: { state: "configured", lastFour: FAKE_OTHER_KEY.slice(-4) },
    });
    expect(await service.forJob(OPENROUTER)).toEqual({
      state: "key",
      apiKey: KEY,
    });
    expect(await service.forJob(FAKE_PROVIDER_ID)).toEqual({
      state: "key",
      apiKey: FAKE_OTHER_KEY,
    });
    // The key of OpenRouter keeps the name it has always had; the other provider's name is its adapter's.
    const names = (await db.selectFrom("secrets").select("name").execute())
      .map((row) => row.name)
      .sort();
    expect(names).toEqual([
      "operator_llm_key",
      `operator_llm_key.${FAKE_PROVIDER_ID}`,
    ]);

    expect(await service.remove(FAKE_PROVIDER_ID)).toBe(true);
    expect(await service.forJob(FAKE_PROVIDER_ID)).toEqual({ state: "none" });
    expect(await service.forJob(OPENROUTER)).toEqual({
      state: "key",
      apiKey: KEY,
    });
    expect(await service.remove(FAKE_PROVIDER_ID)).toBe(false);
    expect(await service.remove(OPENROUTER)).toBe(true);
    expect(await service.forJob(OPENROUTER)).toEqual({ state: "none" });
  });

  // #427-T01
  it("answers the state of every provider, in the order of the registry, without any key", async () => {
    const { service } = await start();
    await service.save({ provider: FAKE_PROVIDER_ID, apiKey: FAKE_KEY }, null);

    const all = await service.statusAll();

    expect(all.map((entry) => entry.provider)).toEqual([
      OPENROUTER,
      FAKE_PROVIDER_ID,
    ]);
    expect(all[0]?.status).toEqual({ state: "not_configured" });
    expect(all[1]?.status).toMatchObject({
      state: "configured",
      lastFour: FAKE_KEY.slice(-4),
    });
    expect(JSON.stringify(all)).not.toContain(FAKE_KEY.slice(0, -4));
  });

  // #427-T01
  it("never lets a key of one provider be read as another's, nor an empty field keep one", async () => {
    const { service } = await start();
    await service.save({ provider: OPENROUTER, apiKey: KEY }, null);

    expect(await service.status(FAKE_PROVIDER_ID)).toEqual({
      state: "not_configured",
    });
    expect(await service.forJob(FAKE_PROVIDER_ID)).toEqual({ state: "none" });
    expect(
      await service.save({ provider: FAKE_PROVIDER_ID, apiKey: "" }, null),
    ).toEqual({
      ok: false,
      issues: [{ field: "apiKey", code: "api_key_required" }],
    });
  });

  // #427-T01
  it("has no slot for a provider that is not registered, or spelled otherwise than its id", async () => {
    const { service, db } = await start();
    await service.save({ provider: OPENROUTER, apiKey: KEY }, null);

    for (const provider of [
      "nobody",
      "OpenRouter",
      " openrouter",
      "openrouter ",
      "",
      "operator_llm_key",
    ]) {
      expect(await service.save({ provider, apiKey: KEY }, null)).toEqual({
        ok: false,
        issues: [{ field: "provider", code: "provider_invalid" }],
      });
      expect(await service.status(provider)).toEqual({
        state: "not_configured",
      });
      expect(await service.forJob(provider)).toEqual({ state: "none" });
      expect(await service.remove(provider)).toBe(false);
    }
    expect(
      await service.save({ provider: 42, apiKey: KEY }, null),
    ).toMatchObject({ ok: false });
    // The key of OpenRouter is still there and nothing else was written.
    expect(await service.forJob(OPENROUTER)).toEqual({
      state: "key",
      apiKey: KEY,
    });
    expect(await db.selectFrom("secrets").select("name").execute()).toEqual([
      { name: "operator_llm_key" },
    ]);
  });
});
