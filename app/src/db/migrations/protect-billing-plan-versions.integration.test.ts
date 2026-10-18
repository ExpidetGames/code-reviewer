// SPDX-License-Identifier: Apache-2.0

// #438 (review N6): the migration that makes the database refuse the update of a plan version beyond its role and the
// delete of a version. It only adds triggers: a version that exists keeps every value, and taking the migration back
// leaves the table as the previous migration made it.
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
import { migration } from "./20261018140000_protect_billing_plan_versions.ts";

const THIS = "20261018140000_protect_billing_plan_versions";
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

/** This migration and the ones before it: what the database looked like when it was written (#439 adds columns later). */
const throughThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name <= THIS,
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

describe("the migration that protects the plan versions", () => {
  it("sorts after the migration that creates them", async () => {
    const names = Object.keys(await migrationProvider.getMigrations()).sort();

    expect(names.indexOf(THIS)).toBeGreaterThan(
      names.indexOf("20261018120000_create_billing_plans"),
    );
  });

  describe.each(ENGINES)("on $name", (engine) => {
    const it_ = engine.skip ? it.skip : it;

    // #438-T12
    it_(
      "keeps a version that exists as it is and then refuses to delete or change it",
      async () => {
        const db = await engine.open();
        await migrateToLatest(db, beforeThisMigration);
        await seedVersion(db);
        const read = async () =>
          (
            await sql<
              Record<string, unknown>
            >`select * from billing_plan_versions`.execute(db)
          ).rows;
        const before = await read();

        await migrateToLatest(db, throughThisMigration);

        expect(await read()).toEqual(before);
        await expect(
          sql`delete from billing_plan_versions where id = 'v1'`.execute(db),
        ).rejects.toThrow(/billing_plan_versions_immutable/);
        await expect(
          sql`update billing_plan_versions set limits = '{"a":1}' where id = 'v1'`.execute(
            db,
          ),
        ).rejects.toThrow(/billing_plan_versions_immutable/);
        await sql`update billing_plan_versions set role = 'legacy' where id = 'v1'`.execute(
          db,
        );
        await db.destroy();
      },
    );

    // #438-T12
    it_(
      "is taken back by its down step, which leaves the table writable again",
      async () => {
        const db = await engine.open();
        await migrateToLatest(db, migrationProvider);
        await seedVersion(db);

        await migration.down?.(db);

        await sql`update billing_plan_versions set limits = '{"a":1}' where id = 'v1'`.execute(
          db,
        );
        await sql`delete from billing_plan_versions where id = 'v1'`.execute(
          db,
        );
        await db.destroy();
      },
    );
  });
});
