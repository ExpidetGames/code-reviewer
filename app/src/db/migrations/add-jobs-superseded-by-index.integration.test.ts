// SPDX-License-Identifier: LicenseRef-Proprietary

// #658: `jobs.superseded_by` refers to `jobs.id`, and without an index every deleted job made the database scan the whole table
// for a job that still points at it (the foreign key's check), so deleting a workspace with n jobs took n scans: 13.6 s for 20 000
// jobs. The earlier index of this column (`jobs_old_superseded_by`, 20261011160100) only served the temporary table of the
// customer-data migration. This migration adds the index to the table that stays.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import type { Database } from "../schema.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

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

type Db = Kysely<Database>;

async function postgresIndexDefinitions(db: Db): Promise<string[]> {
  const { rows } = await sql<{ indexdef: string }>`
    select indexdef from pg_indexes
    where tablename = 'jobs' and indexname = ${INDEX}`.execute(db);
  return rows.map((row) => row.indexdef);
}

describe("the index on jobs.superseded_by", () => {
  it("is added on Postgres and removed again by down", async () => {
    const { db } = await createEmptyTestDatabase();
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
