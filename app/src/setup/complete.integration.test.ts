// SPDX-License-Identifier: Apache-2.0

// Pins down the completion of the first-run setup against a real SQLite file: the admin is created
// with a hashed password and the instance admin flag, the choices are stored, the workspace follows
// the tenancy (a fresh instance, an existing one with an imported workspace, with and without an
// owner), the instance is marked as set up, and two completions at the same moment end with exactly
// one winner.
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { completeSetup } from "./complete.ts";
import { SetupError } from "./errors.ts";
import type { SetupInput } from "./input.ts";

const INPUT: SetupInput = {
  tenancy: "single",
  signUp: { kind: "everyone" },
  admin: { email: "admin@example.com", password: "x7Kq-m2Vd9Lw" },
};

// A stand-in for Better Auth's hash: never the password itself.
const hashPassword = (password: string) =>
  Promise.resolve(`hashed:${password.length}:${"h".repeat(20)}`);

async function fixture() {
  const { db } = await createTestDatabase();
  return {
    db,
    complete: (input: SetupInput = INPUT) =>
      completeSetup(
        { db, hashPassword, checkCredential: () => Promise.resolve(true) },
        input,
      ),
  };
}

async function insertUser(
  db: Awaited<ReturnType<typeof fixture>>["db"],
  id: string,
) {
  await db
    .insertInto("users")
    .values({
      id,
      name: id,
      email: `${id}@users.noreply.github.com`,
      email_verified: 0,
      image: null,
      github_login: id,
      imported_at: "2026-10-11T00:00:00.000Z",
      org_checked_at: null,
      org_checked_for: null,
      created_at: "2026-10-11T00:00:00.000Z",
      updated_at: "2026-10-11T00:00:00.000Z",
    })
    .execute();
}

describe("completing the setup as single-tenant on a fresh instance", () => {
  // #97-SU-11
  it("creates the admin with a hashed password and the instance admin flag", async () => {
    const { db, complete } = await fixture();

    const { userId } = await complete();

    const user = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(user).toMatchObject({
      email: "admin@example.com",
      is_instance_admin: 1,
      github_login: null,
      imported_at: null,
    });
    const account = await db
      .selectFrom("accounts")
      .selectAll()
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(account).toMatchObject({
      provider_id: "credential",
      account_id: userId,
    });
    expect(account.password).toMatch(/^hashed:/);
    expect(account.password).not.toContain("x7Kq-m2Vd9Lw");
  });

  // #97-SU-11
  it("stores the choices and marks the instance as set up", async () => {
    const { db, complete } = await fixture();
    const { userId } = await complete({
      ...INPUT,
      signUp: { kind: "domains", entries: ["example.com"] },
    });

    const settings = createInstanceSettingsRepository(db);

    expect(await settings.get("tenancy")).toBe("single");
    expect(await settings.get("sign_up_rule")).toEqual({
      kind: "domains",
      entries: ["example.com"],
    });
    expect(await settings.get("setup_completed_at")).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
    const rows = await db
      .selectFrom("instance_settings")
      .select(["key", "updated_by"])
      .execute();
    expect(rows.every((row) => row.updated_by === userId)).toBe(true);
  });

  // #97-SU-11
  it("creates the default workspace with the admin as its Owner", async () => {
    const { db, complete } = await fixture();

    const { userId, workspaceId } = await complete();

    const workspaces = await db.selectFrom("workspaces").selectAll().execute();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      id: workspaceId,
      slug: "default",
      created_by: userId,
    });
    expect(
      await db.selectFrom("workspace_members").selectAll().execute(),
    ).toMatchObject([
      { workspace_id: workspaceId, user_id: userId, role: "owner" },
    ]);
  });
});

describe("completing the setup as multi-tenant on a fresh instance", () => {
  // #97-SU-12
  it("creates the admin and the settings, but no workspace", async () => {
    const { db, complete } = await fixture();

    const { workspaceId } = await complete({ ...INPUT, tenancy: "multi" });

    expect(workspaceId).toBeNull();
    expect(await db.selectFrom("workspaces").select("id").execute()).toEqual(
      [],
    );
    expect(
      await db.selectFrom("workspace_members").select("user_id").execute(),
    ).toEqual([]);
    expect(await createInstanceSettingsRepository(db).get("tenancy")).toBe(
      "multi",
    );
    expect(
      await db.selectFrom("users").select("is_instance_admin").execute(),
    ).toEqual([{ is_instance_admin: 1 }]);
  });
});

describe("completing the setup on an existing installation", () => {
  async function existing() {
    const { db, complete } = await fixture();
    await insertUser(db, "imported-a");
    await insertUser(db, "imported-b");
    const workspace = await createWorkspacesRepository(db).create({
      name: "Default workspace",
      slug: "default",
      createdBy: null,
    });
    return { db, complete, workspace };
  }

  // #97-SU-22
  it("adds the admin as an Owner of the imported workspace in single-tenant mode, next to its owner", async () => {
    const { db, complete, workspace } = await existing();
    await createWorkspacesRepository(db).addMember(
      workspace.id,
      "imported-a",
      "owner",
    );

    const { userId, workspaceId } = await complete();

    expect(workspaceId).toBe(workspace.id);
    expect(
      await db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
    const members = await db
      .selectFrom("workspace_members")
      .select(["user_id", "role"])
      .orderBy("user_id")
      .execute();
    expect(members).toEqual(
      [
        { user_id: "imported-a", role: "owner" },
        { user_id: userId, role: "owner" },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
  });

  // #97-SU-22
  it("makes the admin Owner of an imported workspace without an Owner in multi-tenant mode", async () => {
    const { db, complete, workspace } = await existing();
    await createWorkspacesRepository(db).addMember(
      workspace.id,
      "imported-b",
      "member",
    );

    const { userId, workspaceId } = await complete({
      ...INPUT,
      tenancy: "multi",
    });

    expect(workspaceId).toBe(workspace.id);
    expect(
      await db
        .selectFrom("workspace_members")
        .select("role")
        .where("user_id", "=", userId)
        .execute(),
    ).toEqual([{ role: "owner" }]);
  });

  // #97-SU-22
  it("leaves an imported workspace that has an Owner alone in multi-tenant mode", async () => {
    const { db, complete, workspace } = await existing();
    await createWorkspacesRepository(db).addMember(
      workspace.id,
      "imported-a",
      "owner",
    );

    const { userId, workspaceId } = await complete({
      ...INPUT,
      tenancy: "multi",
    });

    expect(workspaceId).toBeNull();
    expect(
      await db
        .selectFrom("workspace_members")
        .select("user_id")
        .where("user_id", "=", userId)
        .execute(),
    ).toEqual([]);
  });

  // #97-SU-23
  it("does not duplicate anything that was imported", async () => {
    const { db, complete } = await existing();

    await complete();

    expect(await db.selectFrom("users").select("id").execute()).toHaveLength(3);
    expect(
      await db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
    expect(
      await db
        .selectFrom("users")
        .select("id")
        .where("imported_at", "is not", null)
        .execute(),
    ).toHaveLength(2);
  });
});

describe("completing the setup twice", () => {
  // #97-SU-13
  it("lets exactly one of two completions at the same moment win", async () => {
    const { db, complete } = await fixture();

    const results = await Promise.allSettled([
      complete(),
      complete({
        ...INPUT,
        admin: { ...INPUT.admin, email: "other@example.com" },
      }),
    ]);

    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    expect(loser?.status === "rejected" && loser.reason).toBeInstanceOf(
      SetupError,
    );
    expect(
      loser?.status === "rejected" && (loser.reason as SetupError).code,
    ).toBe("already_set_up");
    expect(
      await db.selectFrom("users").select("is_instance_admin").execute(),
    ).toEqual([{ is_instance_admin: 1 }]);
    expect(await db.selectFrom("accounts").select("id").execute()).toHaveLength(
      1,
    );
    expect(
      await db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
  });

  // #97-SU-13
  it("refuses a completion after the setup is complete and changes nothing", async () => {
    const { db, complete } = await fixture();
    await complete();

    await expect(
      complete({
        ...INPUT,
        tenancy: "multi",
        admin: { ...INPUT.admin, email: "second@example.com" },
      }),
    ).rejects.toMatchObject({ code: "already_set_up" });

    expect(await db.selectFrom("users").select("id").execute()).toHaveLength(1);
    expect(await createInstanceSettingsRepository(db).get("tenancy")).toBe(
      "single",
    );
  });

  it("refuses an email that an account has already, and writes nothing", async () => {
    const { db, complete } = await fixture();
    await insertUser(db, "someone");
    await db
      .updateTable("users")
      .set({ email: "admin@example.com" })
      .where("id", "=", "someone")
      .execute();

    await expect(complete()).rejects.toMatchObject({ code: "email_in_use" });

    expect(await db.selectFrom("users").select("id").execute()).toHaveLength(1);
    expect(
      await db.selectFrom("instance_settings").select("key").execute(),
    ).toEqual([]);
    expect(await db.selectFrom("workspaces").select("id").execute()).toEqual(
      [],
    );
  });

  // #97-EMAIL
  it("creates nothing and does not mark the setup done when the sign in would not accept the admin", async () => {
    const { db } = await fixture();

    await expect(
      completeSetup(
        { db, hashPassword, checkCredential: () => Promise.resolve(false) },
        INPUT,
      ),
    ).rejects.toMatchObject({ code: "admin_unusable" });

    expect(await db.selectFrom("users").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("accounts").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("workspaces").select("id").execute()).toEqual(
      [],
    );
    expect(
      await db.selectFrom("instance_settings").select("key").execute(),
    ).toEqual([]);
  });

  it("asks the check about the address, the password and the hash it made", async () => {
    const { db } = await fixture();
    const checkCredential = vi.fn(() => Promise.resolve(true));

    await completeSetup({ db, hashPassword, checkCredential }, INPUT);

    expect(checkCredential).toHaveBeenCalledWith({
      email: INPUT.admin.email,
      password: INPUT.admin.password,
      hash: await hashPassword(INPUT.admin.password),
    });
  });

  it("writes nothing when the transaction fails halfway", async () => {
    const { db, complete } = await fixture();
    // The last step of the completion, the marker, fails: the admin and the workspace made before
    // it must not stay.
    await sql`create trigger fail_marker before insert on instance_settings
      when new.key = 'setup_completed_at'
      begin select raise(abort, 'boom'); end`.execute(db);

    await expect(complete()).rejects.toThrow();

    expect(await db.selectFrom("users").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("accounts").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("workspaces").select("id").execute()).toEqual(
      [],
    );
    expect(
      await db.selectFrom("instance_settings").select("key").execute(),
    ).toEqual([]);
  });
});
