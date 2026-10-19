// SPDX-License-Identifier: Apache-2.0

// #425: the model catalog migration adds an empty table to a database made by the previous release's migrations and
// changes no existing row; the table holds the checks and the unique name the repository relies on, on SQLite and on
// Postgres alike.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { MigrationProvider } from "kysely/migration";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { openDatabase } from "../connection.ts";
import {
  createTestDatabase,
  createTestDirectory,
} from "../../test-support/test-database.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";

const SPLIT = "20261017140000_create_model_catalog_entries";

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
const describePostgres = hasPostgres() ? describe : describe.skip;

async function rowsOfEveryTable(
  db: ReturnType<typeof openDatabase>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    // The table of this migration, and the ones that later migrations added.
    if (
      table.name === "model_catalog_entries" ||
      table.name === "billing_journal_entries" ||
      table.name === "billing_balances" ||
      table.name === "job_vm_runs"
    )
      continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)}`.execute(db);
    result[table.name] = rows;
  }
  return result;
}

describe("the model catalog migration", () => {
  it("sorts after every migration that was merged before it", async () => {
    const names = Object.keys(await migrationProvider.getMigrations());

    // Later migrations sort after it; the newest one that sorts before it is the last of the previous release, so a
    // migration inserted between the two (whatever its place in the list) fails here.
    const before = names.filter((name) => name < SPLIT).sort();
    expect(before.at(-1)).toBe("20261017100000_create_job_check_runs");
    expect(names).toContain(SPLIT);
  });

  // #425-T10
  it("applies to an empty database and leaves an empty table", async () => {
    const directory = await createTestDirectory();
    const db = openDatabase({
      driver: "sqlite",
      path: `${directory}/app.db`,
      busyTimeoutMs: 5000,
    });

    await migrateToLatest(db, migrationProvider);

    const { rows } = await sql<{
      count: number;
    }>`select count(*) as count from model_catalog_entries`.execute(db);
    expect(rows).toEqual([{ count: 0 }]);
    await db.destroy();
  });

  // #425-T10
  it("adds an empty table to a populated database and changes no existing row", async () => {
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
    await db
      .insertInto("instance_settings")
      .values({
        key: "managed_model_tiers",
        value: "{}",
        updated_by: null,
        updated_at: T,
      })
      .execute();
    const before = await rowsOfEveryTable(db);
    expect(
      (await db.introspection.getTables()).map((table) => table.name),
    ).not.toContain("model_catalog_entries");

    await migrateToLatest(db, migrationProvider);

    expect(await rowsOfEveryTable(db)).toEqual(before);
    const { rows } = await sql<{
      count: number;
    }>`select count(*) as count from model_catalog_entries`.execute(db);
    expect(rows).toEqual([{ count: 0 }]);
    await db.destroy();
  });

  // #425-T10
  it("is registered once and keeps no default for the model or the provider", async () => {
    const { db } = await createTestDatabase();
    const columns = (await db.introspection.getTables()).find(
      (table) => table.name === "model_catalog_entries",
    )?.columns;

    expect(columns?.map((column) => column.name).sort()).toEqual([
      "created_at",
      "description",
      "id",
      "model_id",
      "name",
      "name_key",
      "provider",
      "serves_diff",
      "serves_dynamic",
      "sort_order",
      "status",
      "updated_at",
      "updated_by",
    ]);
    for (const name of ["model_id", "provider", "name", "name_key"])
      expect(
        columns?.find((column) => column.name === name)?.hasDefaultValue,
      ).toBe(false);
  });
});

describePostgres("the model catalog migration on Postgres", () => {
  // #425-T10
  it("makes the same table as on SQLite", async () => {
    const postgres = await createPostgresTestDatabase();
    const sqlite = await createTestDatabase();
    const shape = async (db: ReturnType<typeof openDatabase>) =>
      (await db.introspection.getTables())
        .find((table) => table.name === "model_catalog_entries")
        ?.columns.map((column) => ({
          name: column.name,
          nullable: column.isNullable,
          hasDefault: column.hasDefaultValue,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const onPostgres = await shape(postgres.db);
    expect(onPostgres?.length).toBe(13);
    // SQLite reports a `text primary key` as nullable; Postgres does not (the generic comparison handles that too).
    expect(onPostgres?.map((c) => [c.name, c.hasDefault])).toEqual(
      (await shape(sqlite.db))?.map((c) => [c.name, c.hasDefault]),
    );
  });
});
