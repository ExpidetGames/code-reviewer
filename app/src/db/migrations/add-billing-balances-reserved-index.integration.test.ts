// SPDX-License-Identifier: LicenseRef-Proprietary

// #591: the sweep of stranded holds asks which workspaces have something reserved. `billing_balances_reserved` is a partial
// index of the balance rows with `reserved_micro_usd > 0`, so that read grows with the holds that are open and not with the
// number of workspaces. Forward only and additive (an index, no column, no row): the rows of an existing database are
// untouched, and the query the sweep asks is answered from the index. On SQLite and, when TEST_DATABASE_URL is set, Postgres.
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

const THIS = "20261021120000_add_billing_balances_reserved_index";
const T = "2026-10-21T08:00:00.000Z";

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

async function seedBalances(db: Db) {
  for (const id of ["w-1", "w-2"])
    await sql`insert into workspaces (id, name, slug, created_by, created_at) values (${id}, ${id}, ${id}, null, ${T})`.execute(
      db,
    );
  await sql`insert into billing_balances (workspace_id, balance_micro_usd, reserved_micro_usd, updated_at) values ('w-1', 5000, 325000, ${T}), ('w-2', 5000, 0, ${T})`.execute(
    db,
  );
}

async function reservedWorkspaces(db: Db): Promise<string[]> {
  const { rows } = await sql<{
    workspace_id: string;
  }>`select workspace_id from billing_balances where reserved_micro_usd > 0 order by workspace_id`.execute(
    db,
  );
  return rows.map((row) => row.workspace_id);
}

describe("the index of the balances that hold something", () => {
  // #591-T22
  it("is added on SQLite, keeps the rows, and answers the read of the sweep", async () => {
    const directory = await createTestDirectory();
    const db = openDatabase({
      driver: "sqlite",
      path: `${directory}/app.db`,
      busyTimeoutMs: 5000,
    });
    try {
      await migrateToLatest(db, beforeThisMigration);
      await seedBalances(db);

      await migrateToLatest(db);

      expect(await reservedWorkspaces(db)).toEqual(["w-1"]);
      const { rows: indexes } = await sql<{
        name: string;
        sql: string;
      }>`select name, sql from sqlite_master where type = 'index' and name = 'billing_balances_reserved'`.execute(
        db,
      );
      expect(indexes).toHaveLength(1);
      expect(indexes[0]?.sql).toContain("reserved_micro_usd");
      const { rows: plan } = await sql<{
        detail: string;
      }>`explain query plan select workspace_id from billing_balances where reserved_micro_usd > 0`.execute(
        db,
      );
      expect(plan.map((row) => row.detail).join("\n")).toContain(
        "billing_balances_reserved",
      );
    } finally {
      await db.destroy();
    }
  });

  // #591-T22
  const onPostgres = hasPostgres() ? it : it.skip;
  onPostgres(
    "is added on Postgres, keeps the rows, and answers the read of the sweep",
    async () => {
      const { db } = await createPostgresTestDatabase({ migrate: false });
      await migrateToLatest(db, beforeThisMigration);
      await seedBalances(db);

      await migrateToLatest(db);

      expect(await reservedWorkspaces(db)).toEqual(["w-1"]);
      const { rows: indexes } = await sql<{
        indexdef: string;
      }>`select indexdef from pg_indexes where indexname = 'billing_balances_reserved'`.execute(
        db,
      );
      expect(indexes).toHaveLength(1);
      expect(indexes[0]?.indexdef).toContain("reserved_micro_usd > 0");
      // With the sequential scan out of the way, the planner shows that the index can answer the query.
      const plan = await db.transaction().execute(async (trx) => {
        await sql`set local enable_seqscan = off`.execute(trx);
        const { rows } = await sql<
          Record<string, string>
        >`explain select workspace_id from billing_balances where reserved_micro_usd > 0`.execute(
          trx,
        );
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      });
      expect(plan).toContain("billing_balances_reserved");
    },
  );
});
