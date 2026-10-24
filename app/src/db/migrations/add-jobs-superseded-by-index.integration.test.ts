// SPDX-License-Identifier: Apache-2.0

// #658: `jobs.superseded_by` refers to `jobs.id`, and without an index every deleted job made the database scan the whole table
// for a job that still points at it (the foreign key's check), so deleting a workspace with n jobs took n scans: 13.6 s for 20 000
// jobs. The earlier index of this column (`jobs_old_superseded_by`, 20261011160100) only served the temporary table of the
// customer-data migration. This migration adds the index to the table that stays. On SQLite and, when TEST_DATABASE_URL is set,
// Postgres.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../connection.ts";
import { migrateToLatest } from "../migrate.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDirectory } from "../../test-support/test-database.ts";
import { migrationProvider } from "./index.ts";

const THIS = "20261023160000_add_jobs_superseded_by_index";
const INDEX = "jobs_superseded_by";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

type Db = ReturnType<typeof openDatabase>;

async function sqliteIndexColumns(db: Db): Promise<string[][]> {
  const { rows } = await sql<{ name: string }>`
    select name from pragma_index_list('jobs') where name = ${INDEX}`.execute(
    db,
  );
  const result: string[][] = [];
  for (const row of rows) {
    const columns = await sql<{ name: string }>`
      select name from pragma_index_info(${row.name}) order by seqno`.execute(
      db,
    );
    result.push(columns.rows.map((column) => column.name));
  }
  return result;
}

async function postgresIndexDefinitions(db: Db): Promise<string[]> {
  const { rows } = await sql<{ indexdef: string }>`
    select indexdef from pg_indexes
    where tablename = 'jobs' and indexname = ${INDEX}`.execute(db);
  return rows.map((row) => row.indexdef);
}

describe("the index on jobs.superseded_by", () => {
  it("is added on SQLite and removed again by down", async () => {
    const directory = await createTestDirectory();
    const db = openDatabase({
      driver: "sqlite",
      path: `${directory}/app.db`,
      busyTimeoutMs: 5000,
    });
    try {
      await migrateToLatest(db, beforeThisMigration);
      expect(await sqliteIndexColumns(db)).toEqual([]);

      await migrateToLatest(db);

      expect(await sqliteIndexColumns(db)).toEqual([["superseded_by"]]);
      const migration = (await migrationProvider.getMigrations())[THIS];
      await migration?.down?.(db);
      expect(await sqliteIndexColumns(db)).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  const onPostgres = hasPostgres() ? it : it.skip;
  onPostgres("is added on Postgres and removed again by down", async () => {
    const { db } = await createPostgresTestDatabase({ migrate: false });
    await migrateToLatest(db, beforeThisMigration);
    expect(await postgresIndexDefinitions(db)).toEqual([]);

    await migrateToLatest(db);

    const definitions = await postgresIndexDefinitions(db);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toContain("(superseded_by)");
    const migration = (await migrationProvider.getMigrations())[THIS];
    await migration?.down?.(db);
    expect(await postgresIndexDefinitions(db)).toEqual([]);
  });
});
