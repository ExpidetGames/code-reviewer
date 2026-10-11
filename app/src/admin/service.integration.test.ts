// SPDX-License-Identifier: Apache-2.0

// Pins down the instance settings service against a real SQLite file: every change of a setting is
// validated, recorded with the admin and the time, and shown back; the rules for the sign-in methods
// and the tenancy hold; two admins saving at once end with one complete write; and the saved secrets
// show up as "configured" and never as a value.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createSecretStore } from "../secrets/store.ts";
import { createAdminService } from "./service.ts";

const APP_SECRET = "service-test-app-secret-0123456789-0123456789";

async function startService(
  options: { githubConfigured?: boolean; mailConfigured?: boolean } = {},
) {
  const { db } = await createTestDatabase();
  for (const id of ["admin-1", "admin-2"])
    await sql`insert into users (id, name, email, email_verified, is_instance_admin, created_at, updated_at)
      values (${id}, ${id}, ${`${id}@example.test`}, 0, 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
  const settings = createInstanceSettingsRepository(db);
  await settings.set("tenancy", "single", null);
  await settings.set("sign_up_rule", { kind: "everyone" }, null);
  let now = new Date("2026-10-11T08:00:00.000Z");
  const flags = {
    github: options.githubConfigured ?? false,
    mail: options.mailConfigured ?? false,
    /** What the access policy answers for a GitHub identity. */
    githubAllowed: true,
  };
  const secrets = createSecretStore({
    db,
    appSecret: APP_SECRET,
    now: () => now,
  });
  const service = createAdminService({
    db,
    secrets,
    githubConfigured: () => flags.github,
    mailConfigured: () => Promise.resolve(flags.mail),
    accessPolicy: () =>
      Promise.resolve(
        flags.githubAllowed
          ? { allowed: true }
          : { allowed: false, reason: "not_allowed" },
      ),
    now: () => now,
  });
  return {
    db,
    settings,
    secrets,
    service,
    flags,
    setTime(value: string) {
      now = new Date(value);
    },
    async linkGithub(userId: string) {
      await sql`update users set github_login = 'octocat' where id = ${userId}`.execute(
        db,
      );
      await sql`insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
        values (${`acc-${userId}`}, '583231', 'github', ${userId}, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
        db,
      );
    },
  };
}

describe("reading the settings", () => {
  it("shows every setting with its value, who saved it and when", async () => {
    const { service, setTime } = await startService();
    setTime("2026-10-11T09:00:00.000Z");
    await service.changeSignUpRule("admin-2", {
      kind: "domains",
      entries: ["example.com"],
    });

    const view = await service.readSettings();

    expect(view.tenancy).toMatchObject({ value: "single", updatedBy: null });
    expect(view.signUpRule).toEqual({
      value: { kind: "domains", entries: ["example.com"] },
      updatedBy: { id: "admin-2", email: "admin-2@example.test" },
      updatedAt: "2026-10-11T09:00:00.000Z",
    });
    expect(view.maxWorkspacesPerUser).toEqual({
      value: 10,
      updatedBy: null,
      updatedAt: null,
    });
  });

  it("offers email with password, and GitHub only where it is configured, when the methods were never saved", async () => {
    const off = await startService({ githubConfigured: false });
    const on = await startService({ githubConfigured: true });

    expect((await off.service.readSettings()).signInMethods.effective).toEqual({
      emailPassword: true,
      github: false,
    });
    expect((await on.service.readSettings()).signInMethods.effective).toEqual({
      emailPassword: true,
      github: true,
    });
  });

  it("counts the workspaces", async () => {
    const { db, service } = await startService();
    await sql`insert into workspaces (id, name, slug, created_by, created_at)
      values ('w1', 'W', 'w', null, '2026-10-11T00:00:00.000Z')`.execute(db);

    expect((await service.readSettings()).workspaceCount).toBe(1);
  });
});

describe("changing the sign-up rule", () => {
  // #98-AD-14
  it("stores the rule with the admin and the time and shows them back", async () => {
    const { service, setTime } = await startService();
    setTime("2026-10-11T10:00:00.000Z");

    const result = await service.changeSignUpRule("admin-1", {
      kind: "emails",
      entries: ["Ada@Example.com", " bob@example.com "],
    });

    expect(result).toEqual({ ok: true });
    expect((await service.readSettings()).signUpRule).toEqual({
      value: {
        kind: "emails",
        entries: ["ada@example.com", "bob@example.com"],
      },
      updatedBy: { id: "admin-1", email: "admin-1@example.test" },
      updatedAt: "2026-10-11T10:00:00.000Z",
    });
  });

  it("refuses a rule that is not valid with the field and a code, and keeps the old one", async () => {
    const { service } = await startService();

    const result = await service.changeSignUpRule("admin-1", {
      kind: "domains",
      entries: ["not a domain"],
    });

    expect(result).toEqual({
      ok: false,
      error: "invalid_input",
      issues: [{ field: "signUp.entries", code: "entry_invalid" }],
    });
    expect((await service.readSettings()).signUpRule.value).toEqual({
      kind: "everyone",
    });
  });

  it("does not delete or lock any account", async () => {
    const { db, service } = await startService();

    await service.changeSignUpRule("admin-1", {
      kind: "emails",
      entries: ["nobody@example.com"],
    });

    const users = await db.selectFrom("users").select("id").execute();
    expect(users.map((user) => user.id).sort()).toEqual(["admin-1", "admin-2"]);
  });

  // #97-SU-19
  it("reports the rule as fail-closed while there is no mail server and sign-in is not GitHub only", async () => {
    const { service, flags } = await startService();
    await service.changeSignUpRule("admin-1", {
      kind: "domains",
      entries: ["example.com"],
    });

    expect((await service.readSettings()).signUpRuleState).toEqual({
      failClosed: true,
    });

    flags.mail = true;
    expect((await service.readSettings()).signUpRuleState).toEqual({
      failClosed: false,
    });
  });
});

describe("changing the ways to sign in", () => {
  // #98-AD-09
  it("refuses to switch both ways off", async () => {
    const { service, settings } = await startService({
      githubConfigured: true,
    });

    const result = await service.changeSignInMethods("admin-1", {
      emailPassword: false,
      github: false,
    });

    expect(result).toEqual({ ok: false, error: "at_least_one_method" });
    expect(await settings.get("sign_in_methods")).toBeUndefined();
  });

  // #98-AD-09
  it("refuses to switch GitHub on while it is not configured", async () => {
    const { service, settings } = await startService({
      githubConfigured: false,
    });

    const result = await service.changeSignInMethods("admin-1", {
      emailPassword: true,
      github: true,
    });

    expect(result).toEqual({ ok: false, error: "github_not_configured" });
    expect(await settings.get("sign_in_methods")).toBeUndefined();
  });

  // #98-AD-16
  it("refuses GitHub only for an admin without a linked GitHub identity, and allows it with one", async () => {
    const { service, settings, linkGithub } = await startService({
      githubConfigured: true,
    });

    const refused = await service.changeSignInMethods("admin-1", {
      emailPassword: false,
      github: true,
    });
    await linkGithub("admin-1");
    const allowed = await service.changeSignInMethods("admin-1", {
      emailPassword: false,
      github: true,
    });

    expect(refused).toEqual({
      ok: false,
      error: "admin_needs_github_identity",
    });
    expect(allowed).toEqual({ ok: true });
    expect(await settings.get("sign_in_methods")).toEqual({
      emailPassword: false,
      github: true,
    });
  });

  // #98-AD-16
  it("refuses GitHub only when the linked identity would not pass the access policy, because nobody could sign in then", async () => {
    const { service, settings, linkGithub, flags } = await startService({
      githubConfigured: true,
    });
    await linkGithub("admin-1");
    flags.githubAllowed = false;

    const result = await service.changeSignInMethods("admin-1", {
      emailPassword: false,
      github: true,
    });

    expect(result).toEqual({
      ok: false,
      error: "admin_needs_github_identity",
    });
    expect(await settings.get("sign_in_methods")).toBeUndefined();
  });

  // #98-AD-16
  it("looks at the identity of the admin who makes the change, not at another admin's", async () => {
    const { service, linkGithub } = await startService({
      githubConfigured: true,
    });
    await linkGithub("admin-2");

    const result = await service.changeSignInMethods("admin-1", {
      emailPassword: false,
      github: true,
    });

    expect(result).toEqual({
      ok: false,
      error: "admin_needs_github_identity",
    });
  });

  // #98-AD-14
  it("records the admin and the time", async () => {
    const { service, setTime } = await startService({ githubConfigured: true });
    setTime("2026-10-11T11:00:00.000Z");

    await service.changeSignInMethods("admin-2", {
      emailPassword: true,
      github: true,
    });

    expect((await service.readSettings()).signInMethods).toMatchObject({
      value: { emailPassword: true, github: true },
      updatedBy: { id: "admin-2" },
      updatedAt: "2026-10-11T11:00:00.000Z",
    });
  });
});

describe("changing the tenancy", () => {
  it("goes through the rules of the tenancy change and records the admin", async () => {
    const { service, db } = await startService();
    await sql`insert into workspaces (id, name, slug, created_by, created_at)
      values ('w1', 'W', 'w', null, '2026-10-11T00:00:00.000Z')`.execute(db);
    await service.changeTenancy("admin-1", "multi");
    await sql`insert into workspaces (id, name, slug, created_by, created_at)
      values ('w2', 'W2', 'w2', null, '2026-10-11T00:00:00.000Z')`.execute(db);

    const refused = await service.changeTenancy("admin-1", "single");

    expect(refused).toEqual({
      ok: false,
      error: "too_many_workspaces",
      count: 2,
    });
    expect((await service.readSettings()).tenancy).toMatchObject({
      value: "multi",
      updatedBy: { id: "admin-1" },
    });
  });
});

describe("changing the limits", () => {
  // #98-AD-14
  it("stores the maximum number of workspaces per user with the admin and the time", async () => {
    const { service, setTime } = await startService();
    setTime("2026-10-11T12:00:00.000Z");

    const result = await service.changeLimits("admin-1", {
      maxWorkspacesPerUser: 3,
    });

    expect(result).toEqual({ ok: true });
    expect((await service.readSettings()).maxWorkspacesPerUser).toEqual({
      value: 3,
      updatedBy: { id: "admin-1", email: "admin-1@example.test" },
      updatedAt: "2026-10-11T12:00:00.000Z",
    });
  });

  it.each([0, -1, 1.5, 1001, Number.NaN, "10", null])(
    "refuses %j as the maximum number of workspaces",
    async (value) => {
      const { service, settings } = await startService();

      const result = await service.changeLimits("admin-1", {
        maxWorkspacesPerUser: value,
      });

      expect(result).toEqual({
        ok: false,
        error: "invalid_input",
        issues: [
          { field: "maxWorkspacesPerUser", code: "number_out_of_range" },
        ],
      });
      expect(await settings.get("max_workspaces_per_user")).toBeUndefined();
    },
  );
});

describe("two admins saving the same setting at once", () => {
  // #98-AD-15
  it("end with one complete write: the value and the admin belong together", async () => {
    const { service, settings } = await startService();

    await Promise.all([
      service.changeSignUpRule("admin-1", {
        kind: "domains",
        entries: ["one.example.com"],
      }),
      service.changeSignUpRule("admin-2", {
        kind: "domains",
        entries: ["two.example.com"],
      }),
    ]);

    const stored = await settings.getWithMeta("sign_up_rule");
    expect([
      {
        updatedBy: "admin-1",
        value: { kind: "domains", entries: ["one.example.com"] },
      },
      {
        updatedBy: "admin-2",
        value: { kind: "domains", entries: ["two.example.com"] },
      },
    ]).toContainEqual({ updatedBy: stored?.updatedBy, value: stored?.value });
  });

  // #98-AD-15
  it("leave the later write standing when they come one after the other", async () => {
    const { service, settings } = await startService();

    await service.changeLimits("admin-1", { maxWorkspacesPerUser: 5 });
    await service.changeLimits("admin-2", { maxWorkspacesPerUser: 7 });

    expect(await settings.getWithMeta("max_workspaces_per_user")).toMatchObject(
      { value: 7, updatedBy: "admin-2" },
    );
  });
});

describe("the secrets in the settings", () => {
  // #98-AD-12
  it("show a saved secret as configured, with the hint if one was asked for, and never the value", async () => {
    const { service, secrets } = await startService();
    await secrets.save("smtp_password", "mail-password-value-12345", {
      updatedBy: "admin-1",
    });
    await secrets.save(
      "github_app_client_secret",
      "client-secret-value-abcdef9876",
      { updatedBy: "admin-1", showLastFour: true },
    );

    const view = await service.readSettings();

    const text = JSON.stringify(view);
    expect(text).not.toContain("mail-password-value");
    expect(text).not.toContain("client-secret-value");
    expect(view.secrets).toContainEqual(
      expect.objectContaining({
        name: "github_app_client_secret",
        state: "configured",
        lastFour: "9876",
      }),
    );
    expect(view.secrets).toContainEqual(
      expect.objectContaining({ name: "smtp_password", state: "configured" }),
    );
  });

  it("show a secret that cannot be decrypted as such instead of failing the page", async () => {
    const { db, service, secrets } = await startService();
    await secrets.save("smtp_password", "mail-password-value-12345", {
      updatedBy: "admin-1",
    });
    await db.updateTable("secrets").set({ nonce: "AAAA" }).execute();

    const view = await service.readSettings();

    expect(view.secrets).toContainEqual(
      expect.objectContaining({
        name: "smtp_password",
        state: "undecryptable",
        code: "secret_undecryptable",
      }),
    );
  });
});
