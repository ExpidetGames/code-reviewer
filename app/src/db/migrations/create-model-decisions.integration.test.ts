// SPDX-License-Identifier: Apache-2.0

// #549: the migration of the admin's model decisions is expand only: it adds two empty tables to a database made by the
// previous release's migrations and changes no existing row, so an app of the previous release keeps working on it.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../connection.ts";
import { migrateToLatest } from "../migrate.ts";
import { createTestDirectory } from "../../test-support/test-database.ts";
import { migrationProvider } from "./index.ts";

const SPLIT = "20261020090000_create_model_decisions";
const NEW_TABLES = ["model_enablements", "model_price_confirmations"];

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < SPLIT,
      ),
    );
  },
};

const T = "2026-10-20T08:00:00.000Z";

describe("the model decisions migration", () => {
  // #549-T04
  it("sorts after every migration before it and adds empty tables without touching an existing row", async () => {
    const names = Object.keys(await migrationProvider.getMigrations()).sort();
    // Later migrations sort after it (#498 added one): none that was merged before it sorts after it.
    expect(names.filter((name) => name <= SPLIT).at(-1)).toBe(SPLIT);
    expect(names.filter((name) => name < SPLIT).at(-1)).toBe(
      "20261019200000_create_models_dev_catalog",
    );

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
    const before = (await sql<unknown>`select * from workspaces`.execute(db))
      .rows;
    const tables = async () =>
      (await db.introspection.getTables()).map((table) => table.name);
    for (const name of NEW_TABLES) expect(await tables()).not.toContain(name);

    await migrateToLatest(db, migrationProvider);

    expect(
      (await sql<unknown>`select * from workspaces`.execute(db)).rows,
    ).toEqual(before);
    for (const name of NEW_TABLES) {
      expect(await tables()).toContain(name);
      const { rows } = await sql<{
        count: number;
      }>`select count(*) as count from ${sql.table(name)}`.execute(db);
      expect(rows).toEqual([{ count: 0 }]);
    }
    await db.destroy();
  });
});
