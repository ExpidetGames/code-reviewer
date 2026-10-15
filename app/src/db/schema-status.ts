// SPDX-License-Identifier: Apache-2.0

// Whether the database has every migration this version of the app ships. A serverless app never
// migrates (that is `pnpm migrate`, run at deployment time, see migrate-cli.ts), so it needs a way to
// tell that it was deployed ahead of its schema. Read-only on purpose: Kysely's own `getMigrations()`
// creates its bookkeeping tables first, and a check must not write.
//
// A database that is AHEAD of the code (migrations this version does not know) is up to date: during a
// rollout the old instances keep running on the new schema, which is why a migration only adds
// (docs: src/db/README.md, "Migrations in serverless mode").
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { databaseDriver } from "./driver.ts";
import { migrationProvider } from "./migrations/index.ts";
import type { Database } from "./schema.ts";

export type SchemaStatus =
  { upToDate: true } | { upToDate: false; pendingCount: number };

// Kysely's default name of the table that records the migrations that ran.
const MIGRATION_TABLE = "kysely_migration";

async function appliedMigrations(db: Kysely<Database>): Promise<Set<string>> {
  const exists =
    databaseDriver(db) === "postgres"
      ? await sql<{
          found: string | null;
        }>`select to_regclass(${MIGRATION_TABLE}) as found`.execute(db)
      : await sql<{
          found: string | null;
        }>`select name as found from sqlite_master where type = 'table' and name = ${MIGRATION_TABLE}`.execute(
          db,
        );
  if (exists.rows[0]?.found == null) return new Set();
  const { rows } = await sql<{
    name: string;
  }>`select name from ${sql.table(MIGRATION_TABLE)}`.execute(db);
  return new Set(rows.map((row) => row.name));
}

export async function readSchemaStatus(
  db: Kysely<Database>,
  provider: MigrationProvider = migrationProvider,
): Promise<SchemaStatus> {
  const known = Object.keys(await provider.getMigrations());
  const applied = await appliedMigrations(db);
  const pendingCount = known.filter((name) => !applied.has(name)).length;
  return pendingCount === 0
    ? { upToDate: true }
    : { upToDate: false, pendingCount };
}
