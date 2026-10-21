// SPDX-License-Identifier: Apache-2.0

// #507: the migration of the memory of the start credit. One new, empty table; an account is granted once (the primary key),
// the account id is a plain number (the check), and the workspace id is not a foreign key, so the row outlives the workspace.
// On SQLite and, when TEST_DATABASE_URL is set, on Postgres.
import { sql, type Kysely } from "kysely";
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
import { addWorkspace } from "../../test-support/workspaces.ts";
import { openDatabase } from "../connection.ts";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";

const MIGRATION = "20261021150000_create_billing_start_credit_grants";
const T = "2026-10-21T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < MIGRATION,
      ),
    );
  },
};

type Engine = {
  name: "sqlite" | "postgres";
  skip: boolean;
  create: () => Promise<Kysely<Database>>;
  createBefore: () => Promise<Kysely<Database>>;
};

const ENGINES: Engine[] = [
  {
    name: "sqlite",
    skip: false,
    async create() {
      return (await createTestDatabase()).db;
    },
    async createBefore() {
      const directory = await createTestDirectory();
      return openDatabase({
        driver: "sqlite",
        path: `${directory}/app.db`,
        busyTimeoutMs: 5000,
      });
    },
  },
  {
    name: "postgres",
    skip: !hasPostgres(),
    async create() {
      return (await createPostgresTestDatabase()).db;
    },
    async createBefore() {
      return (await createPostgresTestDatabase({ migrate: false })).db;
    },
  },
];

const grant = (account: string, workspace = "w") => ({
  github_account_id: account,
  workspace_id: workspace,
  granted_at: T,
});

for (const engine of ENGINES) {
  describe.skipIf(engine.skip)(
    `the start credit grants table on ${engine.name}`,
    () => {
      // #507-T03
      it("grants an account once: a second row for it is refused", async () => {
        const db = await engine.create();
        await db
          .insertInto("billing_start_credit_grants")
          .values(grant("4711"))
          .execute();

        await expect(
          db
            .insertInto("billing_start_credit_grants")
            .values(grant("4711", "another"))
            .execute(),
        ).rejects.toThrow(/unique|primary|duplicate/i);
      });

      // #507-T09
      it("stores only a plain positive number as the account id", async () => {
        const db = await engine.create();

        for (const bad of [
          "",
          "0",
          "012",
          "octocat",
          "12a",
          " 12",
          "-3",
          "1.5",
        ])
          await expect(
            db
              .insertInto("billing_start_credit_grants")
              .values(grant(bad))
              .execute(),
          ).rejects.toThrow();
        await db
          .insertInto("billing_start_credit_grants")
          .values(grant("9007199254740991"))
          .execute();

        expect(
          await db
            .selectFrom("billing_start_credit_grants")
            .selectAll()
            .execute(),
        ).toHaveLength(1);
      });

      // #507-T09
      it("keeps a row when the workspace it names is gone, and takes a workspace id that is not (yet) there", async () => {
        const db = await engine.create();
        const workspaceId = await addWorkspace(db, "gone");
        await db
          .insertInto("billing_start_credit_grants")
          .values(grant("1", workspaceId))
          .execute();
        await db
          .insertInto("billing_start_credit_grants")
          .values(grant("2", "never-existed"))
          .execute();

        await db
          .deleteFrom("workspaces")
          .where("id", "=", workspaceId)
          .execute();

        expect(
          (
            await db
              .selectFrom("billing_start_credit_grants")
              .selectAll()
              .orderBy("github_account_id")
              .execute()
          ).map((row) => row.workspace_id),
        ).toEqual([workspaceId, "never-existed"]);
      });

      // #507-T09
      it("migrates up from the schema of the last release, adding one empty table and changing no row", async () => {
        const db = await engine.createBefore();
        await migrateToLatest(db, beforeThisMigration);
        await addWorkspace(db, "before");
        const before = await db.selectFrom("workspaces").selectAll().execute();

        await migrateToLatest(db);

        expect(await db.selectFrom("workspaces").selectAll().execute()).toEqual(
          before,
        );
        expect(
          await db
            .selectFrom("billing_start_credit_grants")
            .selectAll()
            .execute(),
        ).toEqual([]);
        const names = (
          await sql<{
            name: string;
          }>`select name from kysely_migration order by name`.execute(db)
        ).rows.map((migrated) => migrated.name);
        expect(names).toContain(MIGRATION);
      });
    },
  );
}
