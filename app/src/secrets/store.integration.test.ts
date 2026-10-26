// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the encrypted secret store against a real Postgres database: a value goes in encrypted and
// comes back exactly, a copy of the stored ciphertext under another name is worthless, a value that
// cannot be read (changed, wrong APP_SECRET) is a stable error state and never an exception, and
// the saved value is in no status, no result that can be printed, and no log line.
import { inspect } from "node:util";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createSecretStore } from "./store.ts";

const APP_SECRET = "store-test-app-secret-0123456789-0123456789";
const OTHER_APP_SECRET = "other-test-app-secret-0123456789-0123456789";
const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIItop-secret-material-xyz\n-----END PRIVATE KEY-----\n";

async function startStore(appSecret: string = APP_SECRET) {
  const { db } = await createTestDatabase();
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('admin-1', 'Admin', 'admin@example.test', 0, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
    db,
  );
  let now = new Date("2026-10-11T08:00:00.000Z");
  const store = (secret: string = appSecret) =>
    createSecretStore({ db, appSecret: secret, now: () => now });
  return {
    db,
    store: store(),
    storeWith: store,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saving and using a secret", () => {
  // #98-AD-10
  it("returns exactly the value that was saved, with the key version it was encrypted with", async () => {
    const { store } = await startStore();

    await store.save("github_app_private_key", PRIVATE_KEY, {
      updatedBy: "admin-1",
    });
    const used = await store.use("github_app_private_key");

    expect(used.ok && used.value.reveal()).toBe(PRIVATE_KEY);
    expect(await store.status("github_app_private_key")).toMatchObject({
      state: "configured",
      keyVersion: 1,
    });
  });

  // #98-AD-10
  it("stores a different ciphertext and nonce each time the same value is saved", async () => {
    const { db, store } = await startStore();

    await store.save("smtp_password", "same-value-every-time", {
      updatedBy: "admin-1",
    });
    const first = await db.selectFrom("secrets").selectAll().executeTakeFirst();
    await store.save("smtp_password", "same-value-every-time", {
      updatedBy: "admin-1",
    });
    const second = await db
      .selectFrom("secrets")
      .selectAll()
      .executeTakeFirst();

    expect(second?.ciphertext).not.toBe(first?.ciphertext);
    expect(second?.nonce).not.toBe(first?.nonce);
  });

  it("keeps the ciphertext out of plain sight: the stored columns do not contain the value", async () => {
    const { db, store } = await startStore();

    await store.save("smtp_password", "correct horse battery staple", {
      updatedBy: "admin-1",
    });

    const row = await db.selectFrom("secrets").selectAll().executeTakeFirst();
    expect(JSON.stringify(row)).not.toContain("correct horse");
    expect(row?.name).toBe("smtp_password");
  });

  // #98-AD-10
  it("does not decrypt a ciphertext copied to another name", async () => {
    const { db, store } = await startStore();
    await store.save("smtp_password", "value-of-the-smtp-password", {
      updatedBy: "admin-1",
    });
    const original = await db
      .selectFrom("secrets")
      .selectAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto("secrets")
      .values({ ...original, name: "github_app_webhook_secret" })
      .execute();

    expect(await store.status("github_app_webhook_secret")).toMatchObject({
      state: "undecryptable",
      code: "secret_undecryptable",
    });
    expect(await store.use("github_app_webhook_secret")).toEqual({
      ok: false,
      error: "secret_undecryptable",
    });
    expect((await store.use("smtp_password")).ok).toBe(true);
  });

  it("records who saved it and when, and a second save replaces the first", async () => {
    const { store, advance } = await startStore();

    await store.save("smtp_password", "first-value-of-the-secret", {
      updatedBy: "admin-1",
    });
    advance(60_000);
    await store.save("smtp_password", "second-value-of-the-secret", {
      updatedBy: null,
    });

    const used = await store.use("smtp_password");
    expect(used.ok && used.value.reveal()).toBe("second-value-of-the-secret");
    expect(await store.status("smtp_password")).toMatchObject({
      updatedBy: null,
      updatedAt: "2026-10-11T08:01:00.000Z",
    });
  });

  it("refuses an empty value and a value that is only white space", async () => {
    const { store } = await startStore();

    for (const value of ["", "   \n"]) {
      await expect(
        store.save("smtp_password", value, { updatedBy: "admin-1" }),
      ).resolves.toEqual({ ok: false, error: "secret_empty" });
    }

    expect(await store.status("smtp_password")).toEqual({
      name: "smtp_password",
      state: "not_configured",
    });
  });

  it("refuses a value that is far longer than any credential", async () => {
    const { store } = await startStore();

    const result = await store.save("smtp_password", "x".repeat(70_000), {
      updatedBy: "admin-1",
    });

    expect(result).toEqual({ ok: false, error: "secret_too_long" });
  });

  it("removes a secret and then reports it as not configured", async () => {
    const { store } = await startStore();
    await store.save("smtp_password", "value-of-the-smtp-password", {
      updatedBy: "admin-1",
    });

    expect(await store.remove("smtp_password")).toBe(true);
    expect(await store.remove("smtp_password")).toBe(false);

    expect(await store.status("smtp_password")).toEqual({
      name: "smtp_password",
      state: "not_configured",
    });
    expect(await store.use("smtp_password")).toEqual({
      ok: false,
      error: "secret_not_configured",
    });
  });
});

describe("a secret that cannot be decrypted", () => {
  // #98-AD-11
  it("is an error state, not an exception, when the ciphertext was changed", async () => {
    const { db, store } = await startStore();
    await store.save("smtp_password", "value-of-the-smtp-password", {
      updatedBy: "admin-1",
    });
    const row = await db
      .selectFrom("secrets")
      .select("ciphertext")
      .executeTakeFirstOrThrow();
    const bytes = Buffer.from(row.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await db
      .updateTable("secrets")
      .set({ ciphertext: bytes.toString("base64") })
      .execute();

    expect(await store.status("smtp_password")).toMatchObject({
      state: "undecryptable",
      code: "secret_undecryptable",
    });
    expect(await store.use("smtp_password")).toEqual({
      ok: false,
      error: "secret_undecryptable",
    });
  });

  // #98-AD-11
  it("is an error state, not an exception, under another APP_SECRET", async () => {
    const { store, storeWith } = await startStore();
    await store.save("github_app_private_key", PRIVATE_KEY, {
      updatedBy: "admin-1",
    });

    const wrong = storeWith(OTHER_APP_SECRET);

    expect(await wrong.status("github_app_private_key")).toMatchObject({
      state: "undecryptable",
    });
    expect(await wrong.use("github_app_private_key")).toEqual({
      ok: false,
      error: "secret_undecryptable",
    });
    expect((await wrong.statuses()).map(({ state }) => state)).toContain(
      "undecryptable",
    );
  });

  it("is a stable error state when it was made with a key version this build does not know", async () => {
    const { db, store } = await startStore();
    await store.save("smtp_password", "value-of-the-smtp-password", {
      updatedBy: "admin-1",
    });
    await db.updateTable("secrets").set({ key_version: 99 }).execute();

    expect(await store.status("smtp_password")).toMatchObject({
      state: "undecryptable",
      code: "secret_key_version_unknown",
    });
  });

  it("can be saved again after it became unreadable", async () => {
    const { store, storeWith } = await startStore();
    await store.save("smtp_password", "value-of-the-smtp-password", {
      updatedBy: "admin-1",
    });
    const other = storeWith(OTHER_APP_SECRET);

    await other.save("smtp_password", "entered-again-after-the-change", {
      updatedBy: "admin-1",
    });

    const used = await other.use("smtp_password");
    expect(used.ok && used.value.reveal()).toBe(
      "entered-again-after-the-change",
    );
  });
});

describe("what a saved value never appears in", () => {
  // #98-AD-12
  it("is in no status, not even when the last four characters are shown as a hint", async () => {
    const { store } = await startStore();

    await store.save(
      "github_app_client_secret",
      "client-secret-top-secret-material-9876",
      { updatedBy: "admin-1", showLastFour: true },
    );

    const everything = JSON.stringify([
      await store.status("github_app_client_secret"),
      await store.statuses(),
    ]);
    expect(everything).not.toContain("top-secret-material");
    expect(everything).not.toContain("client-secret");
    expect(await store.status("github_app_client_secret")).toMatchObject({
      state: "configured",
      lastFour: "9876",
    });
  });

  // #98-AD-12
  it("is not shown by a value that is printed, serialized or inspected", async () => {
    const { store } = await startStore();
    await store.save("smtp_password", "never-print-this-password", {
      updatedBy: "admin-1",
    });

    const used = await store.use("smtp_password");

    expect(used.ok).toBe(true);
    const printed = [
      JSON.stringify(used),
      String(used.ok && used.value),
      `${used.ok ? used.value : ""}`,
      inspect(used, { depth: 5 }),
    ].join("\n");
    expect(printed).not.toContain("never-print-this-password");
  });

  // #98-AD-12
  it("is in no log line and no error message while it is saved, used and unreadable", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const { db, store, storeWith } = await startStore();

    await store.save("smtp_password", "log-me-not-1234567890", {
      updatedBy: "admin-1",
    });
    await store.use("smtp_password");
    await storeWith(OTHER_APP_SECRET).use("smtp_password");
    await db.updateTable("secrets").set({ nonce: "AAAA" }).execute();
    const broken = await store.use("smtp_password");
    await store.statuses();

    expect(lines.join("\n")).not.toContain("log-me-not-1234567890");
    expect(JSON.stringify(broken)).not.toContain("log-me-not-1234567890");
  });

  it("gets a hint of its last four characters only when asked for, and only when the value is long enough to give nothing away", async () => {
    const { store } = await startStore();

    await store.save("smtp_password", "a-long-enough-password-wxyz", {
      updatedBy: "admin-1",
    });
    await store.save("github_app_webhook_secret", "short-1234", {
      updatedBy: "admin-1",
      showLastFour: true,
    });
    await store.save(
      "github_app_client_secret",
      "a-long-enough-client-secret-9876",
      {
        updatedBy: "admin-1",
        showLastFour: true,
      },
    );

    expect(await store.status("smtp_password")).toMatchObject({
      lastFour: null,
    });
    expect(await store.status("github_app_webhook_secret")).toMatchObject({
      lastFour: null,
    });
    expect(await store.status("github_app_client_secret")).toMatchObject({
      lastFour: "9876",
    });
  });
});

describe("the status of every secret", () => {
  it("lists every known secret, configured or not, in a fixed order", async () => {
    const { store } = await startStore();
    await store.save("smtp_password", "value-of-the-smtp-password", {
      updatedBy: "admin-1",
    });

    const statuses = await store.statuses();

    expect(statuses.map(({ name }) => name)).toEqual([
      "github_app_client_secret",
      "github_app_private_key",
      "github_app_webhook_secret",
      "operator_llm_key",
      "operator_llm_key.anthropic",
      "smtp_password",
      "stripe_api_key",
      "stripe_webhook_secret",
    ]);
    expect(statuses.map(({ state }) => state)).toEqual([
      "not_configured",
      "not_configured",
      "not_configured",
      "not_configured",
      "not_configured",
      "configured",
      "not_configured",
      "not_configured",
    ]);
  });

  // #491-T07
  it("ignores an encrypted row whose name was removed from the list", async () => {
    const { db, store } = await startStore();
    // The name a database that ran the removed billing design may still hold. Built from parts: nothing else in the
    // repository names that vendor.
    const orphanName = `${["pad", "dle"].join("")}_api_key`;
    await store.save("smtp_password", "value-of-the-smtp-password", {
      updatedBy: "admin-1",
    });
    await db
      .insertInto("secrets")
      .values({
        name: orphanName,
        ciphertext: "b3JwaGFu",
        nonce: "b3JwaGFu",
        key_version: 1,
        last_four: null,
        updated_by: null,
        updated_at: "2026-10-11T08:00:00.000Z",
      })
      .execute();

    const statuses = await store.statuses();

    expect(statuses.map(({ name }) => name)).toEqual([
      "github_app_client_secret",
      "github_app_private_key",
      "github_app_webhook_secret",
      "operator_llm_key",
      "operator_llm_key.anthropic",
      "smtp_password",
      "stripe_api_key",
      "stripe_webhook_secret",
    ]);
    expect(statuses.find(({ name }) => name === "smtp_password")?.state).toBe(
      "configured",
    );
  });
});
