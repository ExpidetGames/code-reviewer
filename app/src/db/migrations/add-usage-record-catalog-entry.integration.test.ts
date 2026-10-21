// SPDX-License-Identifier: Apache-2.0

// #432-T20: the migration adds three nullable columns to `usage_records` of a database made by the previous release's
// migrations. Every existing record stays as it is (the new columns read NULL, `model_tier` is untouched); an app of the
// previous release, which never names the columns, still reserves and settles records; SQLite and Postgres end up with
// the same columns.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import {
  createTestDatabase,
  createTestDirectory,
} from "../../test-support/test-database.ts";
import { openDatabase } from "../connection.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";

const SPLIT = "20261018090000_add_usage_record_catalog_entry";
const COLUMNS = ["catalog_entry_id", "catalog_entry_name", "llm_provider"];

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

const T = "2026-10-18T08:00:00.000Z";
const describePostgres = hasPostgres() ? describe : describe.skip;

describe("the usage record catalog entry migration", () => {
  // #432-T20
  it("adds only nullable columns and leaves the existing records as they were", async () => {
    const directory = await createTestDirectory();
    const db = openDatabase({
      driver: "sqlite",
      path: `${directory}/app.db`,
      busyTimeoutMs: 5000,
    });
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
      // The records are made without their jobs: only the columns of the records are under test.
      await sql`pragma foreign_keys = off`.execute(db);
      await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, model_tier, state, reserved_at)
        values ('u-1', 'w-1', 'job-1', 'diff', 'managed', 'high', 'reserved', ${T})`.execute(
        db,
      );
      const { rows: before } = await sql<
        Record<string, unknown>
      >`select * from usage_records`.execute(db);

      await migrateToLatest(db, migrationProvider);

      const { rows: after } = await sql<
        Record<string, unknown>
      >`select * from usage_records`.execute(db);
      expect(after).toEqual([
        {
          ...before[0],
          catalog_entry_id: null,
          catalog_entry_name: null,
          llm_provider: null,
          // Added by a later migration (#605).
          billing_state: null,
        },
      ]);
      const table = (await db.introspection.getTables()).find(
        (candidate) => candidate.name === "usage_records",
      );
      for (const name of COLUMNS)
        expect(
          table?.columns.find((candidate) => candidate.name === name),
        ).toMatchObject({
          isNullable: true,
          hasDefaultValue: false,
          dataType: "TEXT",
        });
      // An app of the previous release inserts a record without naming the columns.
      await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at)
        values ('u-2', 'w-1', 'job-2', 'diff', 'own', 'reserved', ${T})`.execute(
        db,
      );
      expect(
        await db
          .selectFrom("usage_records")
          .select(["catalog_entry_id", "catalog_entry_name", "llm_provider"])
          .where("id", "=", "u-2")
          .execute(),
      ).toEqual([
        {
          catalog_entry_id: null,
          catalog_entry_name: null,
          llm_provider: null,
        },
      ]);
    } finally {
      await db.destroy();
    }
  });
});

describePostgres("the usage record catalog entry migration on Postgres", () => {
  // #432-T20
  it("makes the same columns as on SQLite", async () => {
    const postgres = await createPostgresTestDatabase();
    const sqlite = await createTestDatabase();
    const columns = async (db: ReturnType<typeof openDatabase>) =>
      (await db.introspection.getTables())
        .find((table) => table.name === "usage_records")
        ?.columns.filter((candidate) => COLUMNS.includes(candidate.name))
        .map((candidate) => [
          candidate.name,
          candidate.isNullable,
          candidate.hasDefaultValue,
        ])
        .sort();

    expect(await columns(postgres.db)).toEqual(await columns(sqlite.db));
    expect(await columns(sqlite.db)).toHaveLength(COLUMNS.length);
  });
});
