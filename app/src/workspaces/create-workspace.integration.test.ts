// SPDX-License-Identifier: Apache-2.0

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

    expect(result).toEqual({ ok: false, error: "tenancy_is_single" });
    const rows = await db.selectFrom("workspaces").selectAll().execute();
    expect(rows).toEqual([]);
  });
});
