// SPDX-License-Identifier: Apache-2.0

// #440: the migration that adds `attempted_at` to `billing_plan_prices`, the time the app last started creating the price of a
// row at Paddle. One nullable column: every row of a database made by the previous release stays as it is and reads NULL,
// SQLite and Postgres end up with the same column, and the migration sorts after the one that made the table.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../connection.ts";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import { createTestDirectory } from "../../test-support/test-database.ts";
import { migrationProvider } from "./index.ts";

const THIS = "20261018180000_add_billing_plan_price_attempted_at";
const T = "2026-10-18T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

const ENGINES: Array<{
  name: string;
  open: () => Promise<Kysely<Database>>;
  skip: boolean;
}> = [
  {
    name: "SQLite",
    open: async () =>
      openDatabase({
        driver: "sqlite",
        path: `${await createTestDirectory()}/app.db`,
        busyTimeoutMs: 5000,
      }),
    skip: false,
  },
  {
    name: "Postgres",
    open: async () => (await createPostgresTestDatabase({ migrate: false })).db,
    skip: !hasPostgres(),
  },
];

describe("the billing plan price attempt time migration", () => {
  // #440-T20
  it("sorts after the migration that made the prices table", async () => {
    const names = Object.keys(await migrationProvider.getMigrations()).sort();

    expect(names.indexOf(THIS)).toBeGreaterThan(
      names.indexOf("20261018160000_create_billing_plan_prices"),
    );
  });

  describe.each(ENGINES)("on $name", (engine) => {
    const it_ = engine.skip ? it.skip : it;

    // #440-T20
    it_(
      "adds one nullable column and keeps the rows of the previous release as they were",
      async () => {
        const db = await engine.open();
        await migrateToLatest(db, beforeThisMigration);
        await sql`insert into billing_plans (id, plan_key, name, description, sort, kind, offered, popular, created_at, updated_at)
          values ('p1', 'team', 'Team', '', 1, 'paid', 1, 0, ${T}, ${T})`.execute(
          db,
        );
        await sql`insert into billing_plan_prices
          (id, plan_id, paddle_price_id, paddle_product_id, paddle_env, interval, frequency, currency, unit_amount_minor, tax_mode, has_overrides, price_type, quantity_min, quantity_max, paddle_status, origin, state, snapshot_at, created_at)
          values ('pr1', 'p1', 'pri_1', 'pro_1', 'sandbox', 'month', 1, 'USD', '1234', 'internal', 0, 'standard', 1, 100, 'active', 'linked', 'ready', ${T}, ${T})`.execute(
          db,
        );
        const read = async () =>
          (
            await sql<
              Record<string, unknown>
            >`select * from billing_plan_prices`.execute(db)
          ).rows;
        const before = await read();

        await migrateToLatest(db, migrationProvider);

        expect(await read()).toEqual(
          before.map((row) => ({ ...row, attempted_at: null })),
        );
      },
    );
  });
});
