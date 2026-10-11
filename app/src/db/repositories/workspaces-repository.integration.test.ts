// SPDX-License-Identifier: Apache-2.0

// The workspaces table: the default workspace is made once, however many requests ask for it at the
// same time, and the oldest workspace is the default.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { createWorkspacesRepository } from "./workspaces-repository.ts";

describe("the workspaces repository", () => {
  it("has no workspace in a fresh database", async () => {
    const { db } = await createTestDatabase();

    expect(await createWorkspacesRepository(db).findDefault()).toBeUndefined();
  });

  it("makes the default workspace on first use and returns the same one afterwards", async () => {
    const { db } = await createTestDatabase();
    const repository = createWorkspacesRepository(db);

    const first = await repository.ensureDefault();
    const second = await repository.ensureDefault();

    expect(first).toMatchObject({ name: "Default workspace", slug: "default" });
    expect(second).toEqual(first);
    expect(
      await db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
  });

  it("makes one default workspace when several requests ask at once", async () => {
    const { db } = await createTestDatabase();
    const repository = createWorkspacesRepository(db);

    const ids = await Promise.all(
      Array.from(
        { length: 5 },
        async () => (await repository.ensureDefault()).id,
      ),
    );

    expect(new Set(ids).size).toBe(1);
    expect(
      await db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(1);
  });

  it("calls the oldest workspace the default one", async () => {
    const { db } = await createTestDatabase();
    let tick = 0;
    const repository = createWorkspacesRepository(
      db,
      () => new Date(Date.UTC(2026, 9, 11, 12, 0, tick++)),
    );
    const older = await repository.create({
      name: "First",
      slug: "first",
      createdBy: null,
    });
    await repository.create({
      name: "Second",
      slug: "second",
      createdBy: null,
    });

    expect((await repository.findDefault())?.id).toBe(older.id);
    expect((await repository.ensureDefault()).id).toBe(older.id);
  });
});

describe("the members of a workspace", () => {
  async function withUsers() {
    const { db } = await createTestDatabase();
    for (const id of ["u1", "u2"])
      await db
        .insertInto("users")
        .values({
          id,
          name: id,
          email: `${id}@example.test`,
          email_verified: 0,
          image: null,
          github_login: null,
          imported_at: null,
          is_instance_admin: 0,
          org_checked_at: null,
          org_checked_for: null,
          created_at: "2026-10-11T00:00:00.000Z",
          updated_at: "2026-10-11T00:00:00.000Z",
        })
        .execute();
    return { db, repository: createWorkspacesRepository(db) };
  }

  it("adds a member with a role and reports whether the workspace has an owner", async () => {
    const { repository } = await withUsers();
    const workspace = await repository.ensureDefault();
    expect(await repository.hasOwner(workspace.id)).toBe(false);

    await repository.addMember(workspace.id, "u1", "member");
    expect(await repository.hasOwner(workspace.id)).toBe(false);

    await repository.addMember(workspace.id, "u2", "owner");
    expect(await repository.hasOwner(workspace.id)).toBe(true);
  });

  it("keeps the role of a user who is a member already", async () => {
    const { db, repository } = await withUsers();
    const workspace = await repository.ensureDefault();
    await repository.addMember(workspace.id, "u1", "owner");

    await repository.addMember(workspace.id, "u1", "member");

    expect(
      await db
        .selectFrom("workspace_members")
        .select("role")
        .where("user_id", "=", "u1")
        .execute(),
    ).toEqual([{ role: "owner" }]);
  });
});
