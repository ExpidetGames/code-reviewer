// SPDX-License-Identifier: Apache-2.0

// Pins down the stored mail server settings against a real SQLite file and the real secret store: the
// password is encrypted at rest and never part of what is read back for a page, an empty password keeps the
// stored one and the explicit clear removes it, a password that cannot be decrypted is a state and not a
// crash, and removing the mail server removes the password with it.
import { sql } from "kysely";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createSecretStore } from "../secrets/store.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createSmtpConfigStore } from "./smtp-config.ts";

const APP_SECRET = "smtp-config-test-secret-0123456789-0123456789";
const PASSWORD = "p4ssw0rd-that-must-stay-secret";

const INPUT = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  user: "mailer",
  password: PASSWORD,
  senderAddress: "reviewer@example.com",
  senderName: "Code Reviewer",
} as const;

async function start(appSecret: string = APP_SECRET) {
  const { db } = await createTestDatabase();
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('admin-1', 'Admin', 'admin@example.test', 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`.execute(
    db,
  );
  const secrets = createSecretStore({ db, appSecret });
  const store = createSmtpConfigStore({ db, secrets });
  const reopened = (secret: string) =>
    createSmtpConfigStore({ db, secrets: createSecretStore({ db, appSecret: secret }) });
  return { db, secrets, store, reopened };
}

describe("the stored mail server settings", () => {
  it("starts with no mail server", async () => {
    const { store } = await start();

    expect(await store.isConfigured()).toBe(false);
    expect(await store.view()).toEqual({
      settings: null,
      password: "none",
      updatedBy: null,
      updatedAt: null,
    });
    expect(await store.resolve()).toBeNull();
  });

  // #100-SM-01
  it("stores the settings, encrypts the password at rest and reads back only that one is set", async () => {
    const { db, store } = await start();

    const saved = await store.save("admin-1", INPUT);

    expect(saved).toEqual({ ok: true });
    expect(await store.isConfigured()).toBe(true);
    const view = await store.view();
    expect(view.settings).toEqual({
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      user: "mailer",
      senderAddress: "reviewer@example.com",
      senderName: "Code Reviewer",
      allowSelfSigned: false,
    });
    expect(view.password).toBe("configured");
    expect(view.updatedBy).toBe("admin-1");
    expect(JSON.stringify(view)).not.toContain(PASSWORD);

    // At rest: the password column is not the password, and the setting row does not hold it either.
    const secretRow = await db
      .selectFrom("secrets")
      .selectAll()
      .where("name", "=", "smtp_password")
      .executeTakeFirstOrThrow();
    expect(secretRow.ciphertext).not.toContain(PASSWORD);
    expect(secretRow.ciphertext).not.toBe(PASSWORD);
    expect(JSON.stringify(secretRow)).not.toContain(PASSWORD);
    expect(secretRow.last_four).toBeNull();
    const settingRow = await db
      .selectFrom("instance_settings")
      .selectAll()
      .where("key", "=", "smtp")
      .executeTakeFirstOrThrow();
    expect(settingRow.value).not.toContain(PASSWORD);

    // Inside the server the sender gets the value, wrapped so that it prints as a placeholder.
    const resolved = await store.resolve();
    expect(resolved?.password.state).toBe("set");
    if (resolved?.password.state === "set") {
      expect(resolved.password.value.reveal()).toBe(PASSWORD);
      expect(inspect(resolved)).not.toContain(PASSWORD);
      expect(JSON.stringify(resolved)).not.toContain(PASSWORD);
    }
  });

  // #100-SM-02
  it("keeps the stored password when the field is empty and removes it on the explicit clear", async () => {
    const { secrets, store } = await start();
    await store.save("admin-1", INPUT);

    const kept = await store.save("admin-1", { ...INPUT, password: "", port: 2525 });
    const afterKeep = await secrets.use("smtp_password");
    const portAfterKeep = (await store.view()).settings?.port;
    const cleared = await store.save("admin-1", {
      ...INPUT,
      password: undefined,
      clearPassword: true,
    });

    expect(kept).toEqual({ ok: true });
    expect(afterKeep.ok && afterKeep.value.reveal()).toBe(PASSWORD);
    expect(portAfterKeep).toBe(2525);
    expect(cleared).toEqual({ ok: true });
    expect(await secrets.status("smtp_password")).toMatchObject({ state: "not_configured" });
    expect((await store.view()).password).toBe("none");
    expect((await store.resolve())?.password.state).toBe("none");
  });

  it("replaces the password when a new one is given", async () => {
    const { secrets, store } = await start();
    await store.save("admin-1", INPUT);

    await store.save("admin-1", { ...INPUT, password: "another-password-value" });

    const used = await secrets.use("smtp_password");
    expect(used.ok && used.value.reveal()).toBe("another-password-value");
  });

  it("asks for the password when a login is set and there is none, and saves nothing", async () => {
    const { store } = await start();

    const result = await store.save("admin-1", { ...INPUT, password: undefined });

    expect(result).toEqual({
      ok: false,
      error: "invalid_input",
      issues: [{ field: "password", code: "password_required" }],
    });
    expect(await store.isConfigured()).toBe(false);
  });

  it("takes no password for a server without a login, and drops the stored one when the login goes", async () => {
    const { secrets, store } = await start();
    const refused = await store.save("admin-1", { ...INPUT, user: undefined });
    await store.save("admin-1", INPUT);

    const saved = await store.save("admin-1", { ...INPUT, user: "", password: undefined });

    expect(refused).toEqual({
      ok: false,
      error: "invalid_input",
      issues: [{ field: "password", code: "user_required" }],
    });
    expect(saved).toEqual({ ok: true });
    expect(await secrets.status("smtp_password")).toMatchObject({ state: "not_configured" });
    expect((await store.resolve())?.password.state).toBe("none");
  });

  it("refuses invalid input with a code per field and stores nothing", async () => {
    const { db, store } = await start();

    const result = await store.save("admin-1", { ...INPUT, port: 0, host: "" });

    expect(result).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await store.isConfigured()).toBe(false);
    expect(await db.selectFrom("secrets").selectAll().execute()).toEqual([]);
  });

  // #100-SM-15
  it("reports a password that cannot be decrypted as a state, keeps the server configured and asks for it again", async () => {
    const { store, reopened } = await start();
    await store.save("admin-1", INPUT);
    const other = reopened("another-app-secret-0123456789-0123456789-xyz");

    expect(await other.isConfigured()).toBe(true);
    expect((await other.view()).password).toBe("unreadable");
    expect((await other.resolve())?.password.state).toBe("unreadable");
    // Keeping what cannot be read is no way to carry on.
    const kept = await other.save("admin-1", { ...INPUT, password: "" });
    expect(kept).toEqual({
      ok: false,
      error: "invalid_input",
      issues: [{ field: "password", code: "password_required" }],
    });
    // Entering it again repairs it.
    const entered = await other.save("admin-1", { ...INPUT, password: "entered-again-value" });
    expect(entered).toEqual({ ok: true });
    expect((await other.view()).password).toBe("configured");
  });

  // #100-SM-07
  it("removes the mail server and its password together, at any time", async () => {
    const { db, store } = await start();
    await store.save("admin-1", INPUT);

    await store.remove();

    expect(await store.isConfigured()).toBe(false);
    expect(await db.selectFrom("secrets").selectAll().execute()).toEqual([]);
    expect(await db.selectFrom("instance_settings").selectAll().where("key", "=", "smtp").execute()).toEqual([]);
  });

  it("treats stored settings that no longer pass the rules as no mail server", async () => {
    const { db, store } = await start();
    await store.save("admin-1", INPUT);
    await db
      .updateTable("instance_settings")
      .set({ value: JSON.stringify({ host: "x y", port: 0 }) })
      .where("key", "=", "smtp")
      .execute();

    expect(await store.isConfigured()).toBe(false);
    expect(await store.resolve()).toBeNull();
  });

  it("never lets a stored setting make the login a secret of the page", async () => {
    const { store } = await start();
    await store.save("admin-1", INPUT);

    const view = await store.view();

    // The user name is a setting and is shown; the password has no field at all.
    expect(view.settings?.user).toBe("mailer");
    expect(Object.keys(view).sort()).toEqual(["password", "settings", "updatedAt", "updatedBy"]);
    expect(Object.keys(view.settings ?? {})).not.toContain("password");
  });
});
