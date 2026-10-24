// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down creating a workspace on behalf of a user against the tenancy (docs/decisions/0001-
// editions-setup-and-accounts.md, sections 2.3 and 2.6): only a multi-tenant instance lets a user
// create a workspace, and the creator becomes its Owner. The check and the insert are one transaction,
// which is what keeps a single-tenant instance from ever holding two workspaces (the race with the
// switch to single is in src/admin/tenancy-race.integration.test.ts).
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createWorkspaceUnderTenancy } from "./create-workspace.ts";

async function startInstance(tenancy: "single" | "multi") {
  const { db } = await createTestDatabase();
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('user-1', 'u', 'u@example.test', 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
    db,
  );
  await createInstanceSettingsRepository(db).set("tenancy", tenancy, null);
  return db;
}

describe("creating a workspace for a user", () => {
  it("makes the creator its Owner when the instance is multi-tenant", async () => {
    const db = await startInstance("multi");

    const result = await createWorkspaceUnderTenancy(db, {
      name: "Team A",
      slug: "team-a",
      creatorId: "user-1",
    });

    expect(result.ok && result.workspace).toMatchObject({
      name: "Team A",
      slug: "team-a",
      createdBy: "user-1",
    });
    const members = await sql<{
      user_id: string;
      role: string;
    }>`select user_id, role from workspace_members`.execute(db);
    expect(members.rows).toEqual([{ user_id: "user-1", role: "owner" }]);
  });

  it("is refused on a single-tenant instance, which has the one workspace the setup made", async () => {
    const db = await startInstance("single");

    const result = await createWorkspaceUnderTenancy(db, {
      name: "Team A",
      slug: "team-a",
      creatorId: "user-1",
    });

    expect(result).toEqual({ ok: false, error: "multi_tenant_required" });
    const rows = await db.selectFrom("workspaces").selectAll().execute();
    expect(rows).toEqual([]);
  });
});

describe("the name and the slug of a new workspace", () => {
  // #101-WM-03
  it("makes the slug from the name and numbers it when a workspace has it already", async () => {
    const db = await startInstance("multi");

    const first = await createWorkspaceUnderTenancy(db, {
      name: "Team A",
      creatorId: "user-1",
    });
    const second = await createWorkspaceUnderTenancy(db, {
      name: "Team A",
      creatorId: "user-1",
    });
    const third = await createWorkspaceUnderTenancy(db, {
      name: "team a",
      creatorId: "user-1",
    });

    expect(
      [first, second, third].map(
        (result) => result.ok && result.workspace.slug,
      ),
    ).toEqual(["team-a", "team-a-2", "team-a-3"]);
  });

  // #101-WM-03
  it.each(["", "   ", "a".repeat(81), "Team\r\nA"])(
    "refuses the name %j and creates nothing",
    async (name) => {
      const db = await startInstance("multi");

      const result = await createWorkspaceUnderTenancy(db, {
        name,
        creatorId: "user-1",
      });

      expect(result).toEqual({ ok: false, error: "invalid_name" });
      expect(await db.selectFrom("workspaces").selectAll().execute()).toEqual(
        [],
      );
    },
  );
});

describe("creations at the same moment", () => {
  // #101-WM-03
  it("give two requests with the same name two different addresses, never an error", async () => {
    const db = await startInstance("multi");
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('user-2', 'u2', 'u2@example.test', 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );

    const results = await Promise.all(
      ["user-1", "user-2", "user-1", "user-2"].map((creatorId) =>
        createWorkspaceUnderTenancy(db, { name: "Team A", creatorId }),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.map((result) => result.ok && result.workspace.slug).sort(),
    ).toEqual(["team-a", "team-a-2", "team-a-3", "team-a-4"]);
  });

  // #101-WM-04
  it("let one person past the limit only as often as the limit says", async () => {
    const db = await startInstance("multi");
    await createInstanceSettingsRepository(db).set(
      "max_workspaces_per_user",
      2,
      null,
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, n) =>
        createWorkspaceUnderTenancy(db, {
          name: `Team ${String(n)}`,
          creatorId: "user-1",
        }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(
      results.filter(
        (result) => !result.ok && result.error === "workspace_limit_reached",
      ),
    ).toHaveLength(3);
  });
});

describe("the limit of workspaces per user", () => {
  async function create(db: Awaited<ReturnType<typeof startInstance>>) {
    return createWorkspaceUnderTenancy(db, {
      name: "Another",
      creatorId: "user-1",
    });
  }

  // #101-WM-04
  it("stops at 10 owned workspaces by default and says so", async () => {
    const db = await startInstance("multi");
    for (let n = 0; n < 10; n += 1) expect((await create(db)).ok).toBe(true);

    expect(await create(db)).toEqual({
      ok: false,
      error: "workspace_limit_reached",
    });
    expect(
      await db.selectFrom("workspaces").select("id").execute(),
    ).toHaveLength(10);
  });

  // #101-WM-04
  it("allows another one as soon as the limit on the Limits page is raised", async () => {
    const db = await startInstance("multi");
    const settings = createInstanceSettingsRepository(db);
    await settings.set("max_workspaces_per_user", 1, null);
    expect((await create(db)).ok).toBe(true);
    expect(await create(db)).toEqual({
      ok: false,
      error: "workspace_limit_reached",
    });

    await settings.set("max_workspaces_per_user", 2, null);

    expect((await create(db)).ok).toBe(true);
  });

  // #101-WM-04
  it("counts the workspaces a person is an Owner of, not the ones they only belong to", async () => {
    const db = await startInstance("multi");
    await createInstanceSettingsRepository(db).set(
      "max_workspaces_per_user",
      1,
      null,
    );
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('user-2', 'u2', 'u2@example.test', 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
    const other = await createWorkspaceUnderTenancy(db, {
      name: "Other",
      creatorId: "user-2",
    });
    if (!other.ok) throw new Error("setup failed");
    await sql`insert into workspace_members (workspace_id, user_id, role, created_at)
      values (${other.workspace.id}, 'user-1', 'admin', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );

    expect((await create(db)).ok).toBe(true);
    expect((await create(db)).ok).toBe(false);
  });

  // #101-WM-04
  it("does not count the workspaces of another person", async () => {
    const db = await startInstance("multi");
    await createInstanceSettingsRepository(db).set(
      "max_workspaces_per_user",
      1,
      null,
    );
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('user-2', 'u2', 'u2@example.test', 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
    await create(db);

    const result = await createWorkspaceUnderTenancy(db, {
      name: "Theirs",
      creatorId: "user-2",
    });

    expect(result.ok).toBe(true);
  });
});
