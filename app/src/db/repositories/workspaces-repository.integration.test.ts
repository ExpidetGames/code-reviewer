// SPDX-License-Identifier: Apache-2.0

// The workspaces table and the questions that start from a user: the oldest workspace is the default, a
// workspace a user does not belong to answers like one that does not exist, and the memberships come back
// in the order the user joined.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { BILLING_ENGINES } from "../../test-support/billing-engines.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { markWorkspaceDeleted } from "../../test-support/workspaces.ts";
import type { Database } from "../schema.ts";
import {
  createWorkspacesRepository,
  isDeleted,
} from "./workspaces-repository.ts";

async function insertUser(db: Kysely<Database>, id: string): Promise<void> {
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
}

describe("the workspaces repository", () => {
  it("has no workspace in a fresh database", async () => {
    const { db } = await createTestDatabase();

    expect(await createWorkspacesRepository(db).findDefault()).toBeUndefined();
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
  });

  it("knows whether a slug is taken", async () => {
    const { db } = await createTestDatabase();
    const repository = createWorkspacesRepository(db);
    await repository.create({ name: "A", slug: "a", createdBy: null });

    expect(await repository.slugExists("a")).toBe(true);
    expect(await repository.slugExists("b")).toBe(false);
  });

  it("renames a workspace and keeps its slug", async () => {
    const { db } = await createTestDatabase();
    const repository = createWorkspacesRepository(db);
    const workspace = await repository.create({
      name: "Old",
      slug: "old",
      createdBy: null,
    });

    expect(await repository.rename(workspace.id, "New")).toBe(true);
    expect(await repository.rename("nobody", "New")).toBe(false);

    expect(await repository.get(workspace.id)).toMatchObject({
      name: "New",
      slug: "old",
    });
  });
});

describe("the members of a workspace", () => {
  async function withUsers() {
    const { db } = await createTestDatabase();
    for (const id of ["u1", "u2"]) await insertUser(db, id);
    return { db, repository: createWorkspacesRepository(db) };
  }

  it("adds a member with a role and reports whether the workspace has an owner", async () => {
    const { repository } = await withUsers();
    const workspace = await repository.create({
      name: "W",
      slug: "w",
      createdBy: null,
    });
    expect(await repository.hasOwner(workspace.id)).toBe(false);

    await repository.addMember(workspace.id, "u1", "member");
    expect(await repository.hasOwner(workspace.id)).toBe(false);

    await repository.addMember(workspace.id, "u2", "owner");
    expect(await repository.hasOwner(workspace.id)).toBe(true);
  });

  it("keeps the role of a user who is a member already", async () => {
    const { db, repository } = await withUsers();
    const workspace = await repository.create({
      name: "W",
      slug: "w",
      createdBy: null,
    });
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

  // #101-WM-06
  it("finds a workspace by slug only for a member, and a stranger gets the answer of a missing slug", async () => {
    const { repository } = await withUsers();
    const workspace = await repository.create({
      name: "W",
      slug: "w",
      createdBy: null,
    });
    await repository.addMember(workspace.id, "u1", "admin");

    expect(await repository.findMembership("u1", "w")).toEqual({
      workspace,
      role: "admin",
    });
    expect(await repository.findMembership("u2", "w")).toBeUndefined();
    expect(await repository.findMembership("u2", "nothing")).toBeUndefined();
    expect(
      await repository.findMembershipById("u2", workspace.id),
    ).toBeUndefined();
    expect(
      (await repository.findMembershipById("u1", workspace.id))?.role,
    ).toBe("admin");
  });

  it("lists the workspaces of a user in the order they joined and counts the ones they own", async () => {
    const { db } = await withUsers();
    let tick = 0;
    const repository = createWorkspacesRepository(
      db,
      () => new Date(Date.UTC(2026, 9, 11, 12, 0, tick++)),
    );
    const first = await repository.create({
      name: "First",
      slug: "first",
      createdBy: null,
    });
    const second = await repository.create({
      name: "Second",
      slug: "second",
      createdBy: null,
    });
    const third = await repository.create({
      name: "Third",
      slug: "third",
      createdBy: null,
    });
    await repository.addMember(third.id, "u1", "member");
    await repository.addMember(first.id, "u1", "owner");
    await repository.addMember(second.id, "u1", "owner");
    await repository.addMember(first.id, "u2", "owner");

    expect(
      (await repository.listForUser("u1")).map((entry) => entry.workspace.slug),
    ).toEqual(["third", "first", "second"]);
    expect(await repository.countOwnedBy("u1")).toBe(2);
    expect(await repository.countOwnedBy("u2")).toBe(1);
    expect(await repository.hasMembership("u1")).toBe(true);
    expect(await repository.hasMembership("nobody")).toBe(false);
    expect(await repository.listForUser("nobody")).toEqual([]);
  });

  // #275-T05
  it("lists workspaces in pages ordered by id, after a cursor, and says whether more follow", async () => {
    const { db } = await createTestDatabase();
    let counter = 0;
    const repository = createWorkspacesRepository(
      db,
      () => new Date("2026-10-11T12:00:00.000Z"),
      () => `ws-${String(++counter)}`,
    );
    for (const slug of ["c", "a", "b", "d"])
      await repository.create({ name: slug, slug, createdBy: null });

    const first = await repository.listPage({ limit: 3 });
    const second = await repository.listPage({
      after: first.workspaces.at(-1)?.id,
      limit: 3,
    });

    expect(first.workspaces.map((w) => w.id)).toEqual(["ws-1", "ws-2", "ws-3"]);
    expect(first.hasMore).toBe(true);
    expect(second.workspaces.map((w) => w.id)).toEqual(["ws-4"]);
    expect(second.hasMore).toBe(false);
  });

  // #275-T05
  it("lists nothing after the last id and for an empty table", async () => {
    const { db } = await createTestDatabase();
    const repository = createWorkspacesRepository(db);

    expect(await repository.listPage({ limit: 10 })).toEqual({
      workspaces: [],
      hasMore: false,
    });
  });
});

describe("the workspaces repository, count and search by name", () => {
  async function seeded() {
    const { db } = await createTestDatabase();
    const repository = createWorkspacesRepository(db);
    const names = ["Acme Corp", "acme labs", "Zeta 100%", "Under_score"];
    for (const [index, name] of names.entries())
      await repository.create({ name, slug: `w${index}`, createdBy: null });
    return repository;
  }

  // #504-T13
  it("counts the workspaces", async () => {
    const repository = await seeded();

    expect(await repository.count()).toBe(4);
  });

  // #504-T10
  it("finds workspaces by a part of the name, whatever the case, in alphabetical order that ignores the case", async () => {
    const repository = await seeded();

    const found = await repository.search("ACME", 10);

    expect(found.map((workspace) => workspace.name)).toEqual([
      "Acme Corp",
      "acme labs",
    ]);
  });

  // #504-T10
  it("takes % and _ as the characters they are, not as wildcards", async () => {
    const repository = await seeded();

    expect(
      (await repository.search("100%", 10)).map((workspace) => workspace.name),
    ).toEqual(["Zeta 100%"]);
    expect(
      (await repository.search("r_s", 10)).map((workspace) => workspace.name),
    ).toEqual(["Under_score"]);
    expect(await repository.search("%", 10)).toHaveLength(1);
  });

  // #504-T10
  it("stops at the limit, and an empty search lists the first workspaces", async () => {
    const repository = await seeded();

    expect(await repository.search("", 2)).toHaveLength(2);
    expect(await repository.search("acme", 1)).toHaveLength(1);
    expect(await repository.search("nothing like this", 5)).toEqual([]);
  });
});

for (const engine of BILLING_ENGINES) {
  // #658-T03
  describe.skipIf(engine.skip)(
    `the workspaces repository and a deleted workspace on ${engine.name}`,
    () => {
      /** Three workspaces; the oldest, which is the default one, is deleted. */
      async function start() {
        const { db, workspaceId, otherWorkspaceId } = await engine.create();
        await insertUser(db, "member");
        const repository = createWorkspacesRepository(db);
        const deletedId = (await repository.findDefault())?.id ?? "none";
        await repository.addMember(deletedId, "member", "owner");
        await repository.addMember(workspaceId, "member", "member");
        await markWorkspaceDeleted(db, deletedId);
        return {
          repository,
          deletedId,
          liveIds: [workspaceId, otherWorkspaceId].sort(),
          workspaceId,
        };
      }

      it("does not count, find, list or search a tombstone, and does not return it by id", async () => {
        const { repository, deletedId, liveIds } = await start();

        expect(await repository.count()).toBe(2);
        expect(
          (await repository.listPage({ limit: 10 })).workspaces.map(
            (w) => w.id,
          ),
        ).toEqual(liveIds);
        expect(await repository.search("deleted", 10)).toEqual([]);
        expect(
          (await repository.search("", 10)).map((w) => w.id).sort(),
        ).toEqual(liveIds);
        expect(await repository.get(deletedId)).toBeUndefined();
        expect((await repository.get(liveIds[0] ?? ""))?.deletedAt).toBeNull();
      });

      it("keeps the tombstone readable by id for the one reader that shows a past payment", async () => {
        const { repository, deletedId } = await start();

        const tombstone = await repository.getIncludingDeleted(deletedId);

        expect(tombstone).toMatchObject({
          id: deletedId,
          name: "Deleted workspace",
          deletedAt: "2026-10-23T12:00:00.000Z",
        });
        expect(isDeleted(tombstone ?? { deletedAt: null })).toBe(true);
      });

      it("never makes a tombstone the default workspace, and finds no membership through it", async () => {
        const { repository, deletedId, workspaceId } = await start();

        expect((await repository.findDefault())?.id).not.toBe(deletedId);
        expect(
          await repository.findMembershipById("member", deletedId),
        ).toBeUndefined();
        expect(
          (await repository.listForUser("member")).map((m) => m.workspace.id),
        ).toEqual([workspaceId]);
      });

      it("still reports the tombstone's own address as taken (the unique index holds it) and the old one as free", async () => {
        const { repository, deletedId } = await start();

        expect(await repository.slugExists(`deleted-${deletedId}`)).toBe(true);
        expect(await repository.slugExists("default")).toBe(false);
      });
    },
  );
}
