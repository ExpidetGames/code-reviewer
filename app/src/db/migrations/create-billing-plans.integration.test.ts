// SPDX-License-Identifier: Apache-2.0

// #438: the billing plans migration adds two empty tables to a database made by the previous release's migrations and
// changes no existing row; the tables hold the checks and the unique indexes the repositories rely on (src/db/repositories/
// billing-plans-repository.ts), on SQLite and on Postgres alike.
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

const SPLIT = "20261018120000_create_billing_plans";
const NEW_TABLES = ["billing_plans", "billing_plan_versions"];

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
    if (NEW_TABLES.includes(table.name)) continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)}`.execute(db);
    result[table.name] = rows;
  }
  return result;
}

describe("the billing plans migration", () => {
  it("sorts after every migration that was merged before it", async () => {
    const names = Object.keys(await migrationProvider.getMigrations());

    const before = names.filter((name) => name < SPLIT).sort();
    expect(before.at(-1)).toBe(
      "20261017160000_add_workspace_entitlements_model_access",
    );
    expect(names).toContain(SPLIT);
  });

  it("adds two empty tables to a populated database and changes no existing row", async () => {
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
        key: "default_entitlements",
        value: '{"planLabel":"Manual"}',
        updated_by: null,
        updated_at: T,
      })
      .execute();
    const before = await rowsOfEveryTable(db);
    const tables = (await db.introspection.getTables()).map(
      (table) => table.name,
    );
    for (const name of NEW_TABLES) expect(tables).not.toContain(name);

    await migrateToLatest(db, migrationProvider);

    expect(await rowsOfEveryTable(db)).toEqual(before);
    for (const name of NEW_TABLES) {
      const { rows } = await sql<{
        count: number;
      }>`select count(*) as count from ${sql.table(name)}`.execute(db);
      expect(rows).toEqual([{ count: 0 }]);
    }
    await db.destroy();
  });

  it("has the columns the repositories read and no default for a price, a key mode or a limit", async () => {
    const { db } = await createTestDatabase();
    const tables = await db.introspection.getTables();
    const columns = (name: string) =>
      tables.find((table) => table.name === name)?.columns;

    expect(
      columns("billing_plans")
        ?.map((column) => column.name)
        .sort(),
    ).toEqual([
      "archived_at",
      "contact_target",
      "created_at",
      "description",
      "id",
      "kind",
      "name",
      "offered",
      "plan_key",
      "popular",
      "sort",
      "updated_at",
      "updated_by",
    ]);
    expect(
      columns("billing_plan_versions")
        ?.map((column) => column.name)
        .sort(),
    ).toEqual([
      "created_at",
      "created_by",
      "id",
      "key_mode",
      "limits",
      "model_access",
      "monthly_amount_minor",
      "number",
      "plan_id",
      "role",
      "yearly_amount_minor",
    ]);
    // An amount is admin data, never a default of the table.
    for (const name of [
      "monthly_amount_minor",
      "yearly_amount_minor",
      "key_mode",
      "limits",
    ])
      expect(
        columns("billing_plan_versions")?.find((column) => column.name === name)
          ?.hasDefaultValue,
      ).toBe(false);
  });
});

describePostgres("the billing plans migration on Postgres", () => {
  it("makes the same tables as on SQLite", async () => {
    const postgres = await createPostgresTestDatabase();
    const sqlite = await createTestDatabase();
    const shape = async (db: ReturnType<typeof openDatabase>, table: string) =>
      (await db.introspection.getTables())
        .find((candidate) => candidate.name === table)
        ?.columns.map((column) => [column.name, column.hasDefaultValue])
        .sort();

    for (const table of NEW_TABLES)
      expect(await shape(postgres.db, table)).toEqual(
        await shape(sqlite.db, table),
      );
  });
});
