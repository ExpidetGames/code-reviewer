// SPDX-License-Identifier: LicenseRef-Proprietary

// #658: a deleted workspace stays as a tombstone because the billing journal points at it, and `deleted_at` is what marks it
// (a nullable column, so no existing row changes and the version that is still running keeps working on the same database).
// Every workspace that exists before the migration stays a live one.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import type { Database } from "../schema.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261023150000_add_workspace_deleted_at";
const T = "2026-10-23T08:00:00.000Z";

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

async function seedWorkspace(db: Db) {
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'Acme', 'acme', null, ${T})`.execute(
    db,
  );
}

async function rowsOf(db: Db): Promise<unknown> {
  const { rows } = await sql<{
    slug: string;
    deleted_at: string | null;
  }>`select slug, deleted_at from workspaces order by id`.execute(db);
  return rows;
}

describe("the deleted_at column of a workspace", () => {
  // #658-T03
  it("is added on Postgres, leaves an existing workspace alive and stores a time", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedWorkspace(db);

    await migrateToLatest(db);

    expect(await rowsOf(db)).toEqual([{ slug: "acme", deleted_at: null }]);
    await sql`update workspaces set deleted_at = ${T} where id = 'w-1'`.execute(
      db,
    );
    expect(await rowsOf(db)).toEqual([{ slug: "acme", deleted_at: T }]);
  });
});
