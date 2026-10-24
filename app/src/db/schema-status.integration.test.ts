// SPDX-License-Identifier: LicenseRef-Proprietary

// What the app can tell about its schema without changing it (#319): whether every migration it ships
// has been applied. It is read-only: nothing is created, nothing is migrated, nothing ends the process.
import { join } from "node:path";
import type { Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import {
  createTestDatabase,
  createTestDirectory,
  track,
} from "../test-support/test-database.ts";
import { openDatabase } from "./connection.ts";
import { migrateToLatest } from "./migrate.ts";
import { migrationProvider } from "./migrations/index.ts";
import { readSchemaStatus } from "./schema-status.ts";
import type { Database } from "./schema.ts";

const noop: Migration = { async up() {} };

function providerOf(...names: string[]): MigrationProvider {
  return {
    getMigrations: async () => Object.fromEntries(names.map((n) => [n, noop])),
  };
}

async function tableNames(db: Kysely<Database>): Promise<string[]> {
  const tables = await db.introspection.getTables({
    withInternalKyselyTables: true,
  });
  return tables.map((t) => t.name).sort();
}

const describePostgres = hasPostgres() ? describe : describe.skip;

describe("readSchemaStatus on SQLite", () => {
  // #319-T02
  it("is up to date when every migration of the code is applied", async () => {
    const { db } = await createTestDatabase();

    expect(await readSchemaStatus(db)).toEqual({ upToDate: true });
  });

  // #319-T02
  it("is behind when the code knows a migration the database has not run, and changes nothing", async () => {
    const { db } = await createTestDatabase();
    const exit = vi.spyOn(process, "exit");
    const before = await tableNames(db);

    const status = await readSchemaStatus(
      db,
      providerOf("0001_create_app_meta", "99990101000000_from_the_future"),
    );

    expect(status).toEqual({ upToDate: false, pendingCount: 1 });
    expect(await tableNames(db)).toEqual(before);
    expect(exit).not.toHaveBeenCalled();
  });

  // #319-T02
  it("is behind, without creating the migration tables, on a database that was never migrated", async () => {
    const directory = await createTestDirectory();
    const db = track(
      openDatabase({
        driver: "sqlite",
        path: join(directory, "app.db"),
        busyTimeoutMs: 1000,
      }),
    );

    const status = await readSchemaStatus(db, providerOf("0001_a", "0002_b"));

    expect(status).toEqual({ upToDate: false, pendingCount: 2 });
    expect(await tableNames(db)).toEqual([]);
  });

  // #319-T02
  it("is up to date when the database is ahead of the code, so an old instance keeps serving during a rollout", async () => {
    const { db } = await createTestDatabase();
    await migrateToLatest(db, {
      getMigrations: async () => ({
        ...(await migrationProvider.getMigrations()),
        "99990101000000_newer": noop,
      }),
    });

    expect(await readSchemaStatus(db)).toEqual({ upToDate: true });
  });
});

describePostgres("readSchemaStatus on Postgres", () => {
  // #319-T02
  it("reports an empty database as behind and the migrated one as up to date, creating nothing", async () => {
    const { db } = await createPostgresTestDatabase({ migrate: false });

    expect(await readSchemaStatus(db)).toMatchObject({ upToDate: false });
    expect(await tableNames(db)).toEqual([]);

    await migrateToLatest(db);

    expect(await readSchemaStatus(db)).toEqual({ upToDate: true });
  });

  // #319-T02
  it("is behind by exactly the migrations that are missing", async () => {
    const { db } = await createPostgresTestDatabase({ migrate: false });
    await migrateToLatest(db, providerOf("0001_a", "0002_b"));

    expect(
      await readSchemaStatus(db, providerOf("0001_a", "0002_b", "0003_c")),
    ).toEqual({ upToDate: false, pendingCount: 1 });
  });
});
