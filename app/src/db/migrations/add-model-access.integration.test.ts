// SPDX-License-Identifier: LicenseRef-Proprietary

// #428-T09: the model access migration adds one nullable column to `workspace_entitlements` of a database made by the
// previous release's migrations. Every existing row stays as it is and reads as "every released entry"; an app of the
// previous release, which never names the column, still writes rows.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";

const SPLIT = "20261017160000_add_workspace_entitlements_model_access";

/** The migrations the previous release's database ran: everything before the new one. */
const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < SPLIT,
      ),
    );
  },
};

const T = "2026-10-17T08:00:00.000Z";

describe("the model access migration", () => {
  // #428-T09
  it("adds only a nullable column and leaves the existing rows as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    try {
      await migrateToLatest(db, beforeThisMigration);
      await db
        .insertInto("workspaces")
        .values({
          id: "w-1",
          name: "acme",
          slug: "acme",
          created_by: null,
          created_at: T,
        })
        .execute();
      await sql`insert into workspace_entitlements (workspace_id, plan_label, key_mode, limits, period_start, suspended, suspension_code, updated_at, updated_by)
        values ('w-1', 'team', 'managed', '{"diffRunsPerPeriod":5}', ${T}, 0, null, ${T}, null)`.execute(
        db,
      );
      const { rows: before } = await sql<
        Record<string, unknown>
      >`select * from workspace_entitlements`.execute(db);

      await migrateToLatest(db, migrationProvider);

      const { rows: after } = await sql<
        Record<string, unknown>
      >`select * from workspace_entitlements`.execute(db);
      expect(after).toEqual([{ ...before[0], model_access: null }]);
      const column = (await db.introspection.getTables())
        .find((table) => table.name === "workspace_entitlements")
        ?.columns.find((candidate) => candidate.name === "model_access");
      expect(column).toMatchObject({
        isNullable: true,
        hasDefaultValue: false,
        dataType: "text",
      });
      // An app of the previous release inserts a row without naming the column.
      await db
        .insertInto("workspaces")
        .values({
          id: "w-2",
          name: "beta",
          slug: "beta",
          created_by: null,
          created_at: T,
        })
        .execute();
      await sql`insert into workspace_entitlements (workspace_id, plan_label, key_mode, limits, period_start, suspended, updated_at)
        values ('w-2', 'team', 'own', '{}', ${T}, 0, ${T})`.execute(db);
      expect(
        await db
          .selectFrom("workspace_entitlements")
          .select(["workspace_id", "model_access"])
          .where("workspace_id", "=", "w-2")
          .execute(),
      ).toEqual([{ workspace_id: "w-2", model_access: null }]);
    } finally {
      await db.destroy();
    }
  });
});
