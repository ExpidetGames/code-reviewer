// SPDX-License-Identifier: Apache-2.0

// #281: the refusal notices migration adds an empty table to a database made by the previous release's migrations
// and changes no existing row, and the table holds the dedupe and the checks the repository relies on.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { MigrationProvider } from "kysely/migration";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { openDatabase } from "../connection.ts";
import { createTestDirectory } from "../../test-support/test-database.ts";

const SPLIT = "20261016090000_create_refusal_notices";

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

const T = "2026-10-12T08:00:00.000Z";

async function rowsOfEveryTable(
  db: ReturnType<typeof openDatabase>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (
      table.name === "refusal_notices" ||
      table.name === "plan_handoff_tokens"
    )
      continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)}`.execute(db);
    result[table.name] = rows;
  }
  return result;
}

describe("the refusal notices migration", () => {
  // #281 (no case of its own: the migration is not a behavior of the issue)
  it("adds an empty table to an existing database and changes no existing row", async () => {
    const directory = await createTestDirectory();
    const db = openDatabase({
      driver: "sqlite",
      path: `${directory}/app.db`,
      busyTimeoutMs: 5000,
    });
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
    const before = await rowsOfEveryTable(db);
    expect(
      (await db.introspection.getTables()).map((table) => table.name),
    ).not.toContain("refusal_notices");

    await migrateToLatest(db, migrationProvider);

    expect(await rowsOfEveryTable(db)).toEqual(before);
    const { rows } = await sql<{
      count: number;
    }>`select count(*) as count from refusal_notices`.execute(db);
    expect(rows).toEqual([{ count: 0 }]);
    await db.destroy();
  });
});
