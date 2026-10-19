// SPDX-License-Identifier: Apache-2.0

// #405 (T36): the job check runs migration is expand only: it adds an empty table to a database made by the previous
// release's migrations and changes no existing row, and the table holds the key and the checks the repository
// relies on.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { MigrationProvider } from "kysely/migration";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { openDatabase } from "../connection.ts";
import { createTestDirectory } from "../../test-support/test-database.ts";

const SPLIT = "20261017100000_create_job_check_runs";

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
      table.name === "job_check_runs" ||
      table.name === "model_catalog_entries" ||
      table.name === "billing_journal_entries" ||
      table.name === "billing_balances" ||
      table.name === "job_vm_runs" ||
      table.name === "billing_topup_intents" ||
      table.name === "billing_webhook_events"
    )
      continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)}`.execute(db);
    result[table.name] = rows;
  }
  return result;
}

describe("the job check runs migration", () => {
  // #405-T36
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
    ).not.toContain("job_check_runs");

    await migrateToLatest(db, migrationProvider);

    expect(await rowsOfEveryTable(db)).toEqual(before);
    const { rows } = await sql<{
      count: number;
    }>`select count(*) as count from job_check_runs`.execute(db);
    expect(rows).toEqual([{ count: 0 }]);
    await db.destroy();
  });

  // #405-T36
  it("refuses a row for a job that does not exist", async () => {
    const directory = await createTestDirectory();
    const db = openDatabase({
      driver: "sqlite",
      path: `${directory}/app.db`,
      busyTimeoutMs: 5000,
    });
    await migrateToLatest(db, migrationProvider);
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
    const insert = (jobId: string) =>
      sql`insert into job_check_runs (job_id, workspace_id, next_attempt_at, created_at, updated_at)
        values (${jobId}, 'w-1', ${T}, ${T}, ${T})`.execute(db);

    await expect(insert("no-such-job")).rejects.toThrow();
    await db.destroy();
  });
});
