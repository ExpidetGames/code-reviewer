// SPDX-License-Identifier: Apache-2.0

// #439: the migration that adds the cache of linked Paddle prices (`billing_plan_prices`), the product a plan was bound to
// and the two price links of a version. It adds one empty table and nullable columns, changes no existing row and keeps a
// version immutable but for its role and its two links, on SQLite and on Postgres alike.
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
import { migration } from "./20261018160000_create_billing_plan_prices.ts";
import { migrationProvider } from "./index.ts";

const THIS = "20261018160000_create_billing_plan_prices";
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

async function seedVersion(db: Kysely<Database>) {
  await sql`insert into billing_plans (id, plan_key, name, description, sort, kind, offered, popular, created_at, updated_at)
    values ('p1', 'team', 'Team', '', 1, 'paid', 1, 0, ${T}, ${T})`.execute(db);
  await sql`insert into billing_plan_versions (id, plan_id, number, role, key_mode, limits, model_access, monthly_amount_minor, created_at)
    values ('v1', 'p1', 1, 'current', 'managed', '{}', '{"catalogEntries":null}', 1234, ${T})`.execute(
    db,
  );
}

type PriceValues = {
  id: string;
  paddle_price_id: string;
  paddle_env: string;
  unit_amount_minor: string;
  has_overrides: number;
  quantity_min: number;
  quantity_max: number;
  origin: string;
  state: string;
};

function insertPrice(
  db: Kysely<Database>,
  overrides: Partial<PriceValues> = {},
) {
  const v: PriceValues = {
    id: "pr1",
    paddle_price_id: "pri_pr1",
    paddle_env: "sandbox",
    unit_amount_minor: "1234",
    has_overrides: 0,
    quantity_min: 1,
    quantity_max: 100,
    origin: "linked",
    state: "ready",
    ...overrides,
  };
  return sql`insert into billing_plan_prices
    (id, plan_id, paddle_price_id, paddle_product_id, paddle_env, interval, frequency, currency, unit_amount_minor, tax_mode, has_overrides, quantity_min, quantity_max, paddle_status, origin, state, snapshot_at, created_at)
    values (${v.id}, 'p1', ${v.paddle_price_id}, 'pro_1', ${v.paddle_env}, 'month', 1, 'USD', ${v.unit_amount_minor}, 'internal', ${v.has_overrides}, ${v.quantity_min}, ${v.quantity_max}, 'active', ${v.origin}, ${v.state}, ${T}, ${T})`.execute(
    db,
  );
}

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

describe("the billing plan prices migration", () => {
  it("sorts after the migration that protects the plan versions", async () => {
    const names = Object.keys(await migrationProvider.getMigrations()).sort();

    expect(names.indexOf(THIS)).toBeGreaterThan(
      names.indexOf("20261018140000_protect_billing_plan_versions"),
    );
  });

  describe.each(ENGINES)("on $name", (engine) => {
    const it_ = engine.skip ? it.skip : it;

    it_(
      "keeps every existing row and adds an empty table and null links",
      async () => {
        const db = await engine.open();
        await migrateToLatest(db, beforeThisMigration);
        await seedVersion(db);
        const read = async (table: string) =>
          (
            await sql<
              Record<string, unknown>
            >`select * from ${sql.table(table)}`.execute(db)
          ).rows;
        const plansBefore = await read("billing_plans");
        const versionsBefore = await read("billing_plan_versions");

        await migrateToLatest(db, migrationProvider);

        expect(await read("billing_plan_prices")).toEqual([]);
        expect(await read("billing_plans")).toEqual(
          plansBefore.map((row) => ({
            ...row,
            paddle_product_id: null,
            paddle_product_env: null,
          })),
        );
        expect(await read("billing_plan_versions")).toEqual(
          versionsBefore.map((row) => ({
            ...row,
            monthly_price_id: null,
            yearly_price_id: null,
          })),
        );
        await db.destroy();
      },
    );

    it_(
      "makes the version link its prices and nothing else of the version changes",
      async () => {
        const db = await engine.open();
        await migrateToLatest(db, migrationProvider);
        await seedVersion(db);
        await insertPrice(db);

        await sql`update billing_plan_versions set monthly_price_id = 'pr1' where id = 'v1'`.execute(
          db,
        );
        await insertPrice(db, { id: "pr2", paddle_price_id: "pri_pr2" });
        await sql`update billing_plan_versions set monthly_price_id = 'pr2', yearly_price_id = 'pr1' where id = 'v1'`.execute(
          db,
        );
        // Review of #468, N1: a link is replaced, never cleared.
        for (const slot of ["monthly_price_id", "yearly_price_id"])
          await expect(
            sql`update billing_plan_versions set ${sql.ref(slot)} = null where id = 'v1'`.execute(
              db,
            ),
            slot,
          ).rejects.toThrow(/billing_plan_versions_immutable/);

        await expect(
          sql`update billing_plan_versions set monthly_amount_minor = 1 where id = 'v1'`.execute(
            db,
          ),
        ).rejects.toThrow(/billing_plan_versions_immutable/);
        await expect(
          sql`update billing_plan_versions set limits = '{"a":1}', monthly_price_id = 'pr1' where id = 'v1'`.execute(
            db,
          ),
        ).rejects.toThrow(/billing_plan_versions_immutable/);
        await expect(
          sql`delete from billing_plan_versions where id = 'v1'`.execute(db),
        ).rejects.toThrow(/billing_plan_versions_immutable/);
        await db.destroy();
      },
    );

    it_(
      "refuses a link to a price that does not exist and a second row for the same Paddle price",
      async () => {
        const db = await engine.open();
        await migrateToLatest(db, migrationProvider);
        await seedVersion(db);
        await insertPrice(db);

        await expect(
          sql`update billing_plan_versions set monthly_price_id = 'nope' where id = 'v1'`.execute(
            db,
          ),
        ).rejects.toThrow();
        await expect(insertPrice(db, { id: "pr2" })).rejects.toThrow();
        await db.destroy();
      },
    );

    it_(
      "lets the table refuse an unknown origin, state or environment and an empty amount",
      async () => {
        const db = await engine.open();
        await migrateToLatest(db, migrationProvider);
        await seedVersion(db);
        const refused: Array<Partial<PriceValues>> = [
          { origin: "typed" },
          { state: "done" },
          { paddle_env: "staging" },
          { unit_amount_minor: "" },
          { has_overrides: 2 },
          // Review of #468, N2: the quantity limits are from one up.
          { quantity_min: 0 },
          { quantity_max: 0 },
        ];

        for (const [index, overrides] of refused.entries())
          await expect(
            insertPrice(db, {
              id: `bad${index}`,
              paddle_price_id: `pri_bad${index}`,
              ...overrides,
            }),
            JSON.stringify(overrides),
          ).rejects.toThrow();
        await db.destroy();
      },
    );

    it_("is taken back by its down step", async () => {
      const db = await engine.open();
      await migrateToLatest(db, migrationProvider);
      await seedVersion(db);

      await migration.down?.(db);

      const tables = (await db.introspection.getTables()).map(
        (table) => table.name,
      );
      expect(tables).not.toContain("billing_plan_prices");
      expect(await columnsOf(db, "billing_plan_versions")).not.toContain(
        "monthly_price_id",
      );
      expect(await columnsOf(db, "billing_plans")).not.toContain(
        "paddle_product_id",
      );
      await expect(
        sql`update billing_plan_versions set limits = '{"a":1}' where id = 'v1'`.execute(
          db,
        ),
      ).rejects.toThrow(/billing_plan_versions_immutable/);
      await db.destroy();
    });
  });
});

async function columnsOf(
  db: Kysely<Database>,
  table: string,
): Promise<string[]> {
  return (
    (await db.introspection.getTables())
      .find((candidate) => candidate.name === table)
      ?.columns.map((column) => column.name) ?? []
  );
}
