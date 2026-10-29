// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the stored mail server settings against a real Postgres database and the real secret store: the
// password is encrypted at rest and never part of what is read back for a page, an empty password keeps the
// stored one and the explicit clear removes it, a password that cannot be decrypted is a state and not a
// crash, and removing the mail server removes the password with it.
import { SMTP_SECRET_NAMES } from "../secret-names/names.ts";
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
  senderName: "code-review.com",
} as const;

async function start(appSecret: string = APP_SECRET) {
  const { db } = await createTestDatabase();
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('admin-1', 'Admin', 'admin@example.test', 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`.execute(
    db,
  );
  const secrets = createSecretStore({
    db,
    names: SMTP_SECRET_NAMES,
    appSecret,
  });
  const store = createSmtpConfigStore({ db, appSecret });
  const reopened = (secret: string) =>
    createSmtpConfigStore({ db, appSecret: secret });
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
      senderName: "code-review.com",
      allowSelfSigned: false,
      allowPlainTextLogin: false,
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

    const kept = await store.save("admin-1", {
      ...INPUT,
      password: "",
      senderName: "Kept",
    });
    const afterKeep = await secrets.use("smtp_password");
    const nameAfterKeep = (await store.view()).settings?.senderName;
    const cleared = await store.save("admin-1", {
      ...INPUT,
      password: undefined,
      clearPassword: true,
    });

    expect(kept).toEqual({ ok: true });
    expect(afterKeep.ok && afterKeep.value.reveal()).toBe(PASSWORD);
    expect(nameAfterKeep).toBe("Kept");
    expect(cleared).toEqual({ ok: true });
    expect(await secrets.status("smtp_password")).toMatchObject({
      state: "not_configured",
    });
    expect((await store.view()).password).toBe("none");
    expect((await store.resolve())?.password.state).toBe("none");
  });

  it("replaces the password when a new one is given", async () => {
    const { secrets, store } = await start();
    await store.save("admin-1", INPUT);

    await store.save("admin-1", {
      ...INPUT,
      password: "another-password-value",
    });

    const used = await secrets.use("smtp_password");
    expect(used.ok && used.value.reveal()).toBe("another-password-value");
  });

  it("asks for the password when a login is set and there is none, and saves nothing", async () => {
    const { store } = await start();

    const result = await store.save("admin-1", {
      ...INPUT,
      password: undefined,
    });

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

    const saved = await store.save("admin-1", {
      ...INPUT,
      user: "",
      password: undefined,
    });

    expect(refused).toEqual({
      ok: false,
      error: "invalid_input",
      issues: [{ field: "password", code: "user_required" }],
    });
    expect(saved).toEqual({ ok: true });
    expect(await secrets.status("smtp_password")).toMatchObject({
      state: "not_configured",
    });
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
  it("reports a password that cannot be decrypted as a state, cannot send, and asks for it again", async () => {
    const { store, reopened } = await start();
    await store.save("admin-1", INPUT);
    const other = reopened("another-app-secret-0123456789-0123456789-xyz");

    // Saved, but nothing could be sent: nothing is offered that could never work.
    expect(await other.isSaved()).toBe(true);
    expect(await other.isConfigured()).toBe(false);
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
    const entered = await other.save("admin-1", {
      ...INPUT,
      password: "entered-again-value",
    });
    expect(entered).toEqual({ ok: true });
    expect((await other.view()).password).toBe("configured");
  });

  // #100-review-4
  it("can send only with a password that can be read when there is a login", async () => {
    const { store, secrets } = await start();
    await store.save("admin-1", INPUT);
    const withPassword = await store.isConfigured();

    await store.save("admin-1", {
      ...INPUT,
      password: undefined,
      clearPassword: true,
    });
    const loginWithoutPassword = [
      await store.isConfigured(),
      await store.isSaved(),
    ];
    await store.save("admin-1", { ...INPUT, user: "", password: undefined });
    const noLogin = await store.isConfigured();

    expect(withPassword).toBe(true);
    expect(loginWithoutPassword).toEqual([false, true]);
    expect(noLogin).toBe(true);
    expect((await secrets.status("smtp_password")).state).toBe(
      "not_configured",
    );
  });

  // #100-review-2
  describe("the saved password and another server", () => {
    it.each([
      ["host", { host: "smtp.attacker.example" }],
      ["port", { port: 2525 }],
      ["user", { user: "someone-else" }],
      ["security", { security: "tls" }],
    ])(
      "is not kept when the %s changes: it has to be entered again",
      async (_field, change) => {
        const { store, secrets } = await start();
        await store.save("admin-1", INPUT);

        const result = await store.save("admin-1", {
          ...INPUT,
          password: "",
          ...change,
        });

        expect(result).toEqual({
          ok: false,
          error: "invalid_input",
          issues: [
            { field: "password", code: "password_required_for_new_server" },
          ],
        });
        // Nothing changed: the old server, the old password.
        expect((await store.view()).settings).toMatchObject({
          host: "smtp.example.com",
          port: 587,
        });
        const used = await secrets.use("smtp_password");
        expect(used.ok && used.value.reveal()).toBe(PASSWORD);
      },
    );

    it("moves with a new password entered for the new server", async () => {
      const { store, secrets } = await start();
      await store.save("admin-1", INPUT);

      const result = await store.save("admin-1", {
        ...INPUT,
        host: "smtp.other.example",
        password: "entered-for-the-new-one",
      });

      expect(result).toEqual({ ok: true });
      const used = await secrets.use("smtp_password");
      expect(used.ok && used.value.reveal()).toBe("entered-for-the-new-one");
    });

    it("still keeps the password when only the sender, the name or the certificate setting change", async () => {
      const { store, secrets } = await start();
      await store.save("admin-1", INPUT);

      const result = await store.save("admin-1", {
        ...INPUT,
        password: "",
        senderAddress: "other@example.com",
        senderName: "Other",
        allowSelfSigned: true,
      });

      expect(result).toEqual({ ok: true });
      const used = await secrets.use("smtp_password");
      expect(used.ok && used.value.reveal()).toBe(PASSWORD);
    });

    it("lets the explicit clear and a new server without a login through", async () => {
      const { store } = await start();
      await store.save("admin-1", INPUT);

      const cleared = await store.save("admin-1", {
        ...INPUT,
        host: "smtp.other.example",
        password: undefined,
        clearPassword: true,
      });
      const noLogin = await store.save("admin-1", {
        ...INPUT,
        host: "relay.internal",
        user: "",
        password: undefined,
      });

      expect(cleared).toEqual({ ok: true });
      expect(noLogin).toEqual({ ok: true });
    });
  });

  // #100-review-6
  it("refuses a login without encryption that the admin did not confirm, and takes a confirmed one", async () => {
    const { store } = await start();

    const refused = await store.save("admin-1", {
      ...INPUT,
      security: "none",
      port: 25,
    });
    const confirmed = await store.save("admin-1", {
      ...INPUT,
      security: "none",
      port: 25,
      allowPlainTextLogin: true,
    });

    expect(refused).toEqual({
      ok: false,
      error: "invalid_input",
      issues: [
        {
          field: "allowPlainTextLogin",
          code: "plain_text_login_not_confirmed",
        },
      ],
    });
    expect(confirmed).toEqual({ ok: true });
    expect((await store.view()).settings).toMatchObject({
      security: "none",
      allowPlainTextLogin: true,
    });
  });

  // #100-review-9
  describe("changing the settings and the password together", () => {
    it("saves neither when the settings cannot be written", async () => {
      const { db, store } = await start();
      await sql`drop table instance_settings`.execute(db);

      await expect(store.save("admin-1", INPUT)).rejects.toThrow();

      expect(await db.selectFrom("secrets").selectAll().execute()).toEqual([]);
    });

    it("keeps the settings when the password cannot be removed", async () => {
      const { db, store } = await start();
      await store.save("admin-1", INPUT);
      await sql`drop table secrets`.execute(db);

      await expect(store.remove()).rejects.toThrow();

      expect(
        await db
          .selectFrom("instance_settings")
          .selectAll()
          .where("key", "=", "smtp")
          .execute(),
      ).toHaveLength(1);
    });
  });

  // #100-SM-07
  it("removes the mail server and its password together, at any time", async () => {
    const { db, store } = await start();
    await store.save("admin-1", INPUT);

    await store.remove();

    expect(await store.isConfigured()).toBe(false);
    expect(await db.selectFrom("secrets").selectAll().execute()).toEqual([]);
    expect(
      await db
        .selectFrom("instance_settings")
        .selectAll()
        .where("key", "=", "smtp")
        .execute(),
    ).toEqual([]);
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
    expect(Object.keys(view).sort()).toEqual([
      "password",
      "settings",
      "updatedAt",
      "updatedBy",
    ]);
    expect(Object.keys(view.settings ?? {})).not.toContain("password");
  });
});
