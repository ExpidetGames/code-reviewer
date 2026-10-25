// SPDX-License-Identifier: LicenseRef-Proprietary

// What `pnpm migrate` does with a database, as a function for the tests that start a database like a deployment does:
// open the pool, prove that the server answers, bring the schema to the latest version. The connection is closed
// again when that fails.
import type { Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import type { PostgresDatabaseConfig } from "../db/config.ts";
import { migrateToLatest } from "../db/migrate.ts";
import {
  assertPostgresReachable,
  openPostgresDatabase,
} from "../db/postgres.ts";
import type { Database } from "../db/schema.ts";

export async function startDatabase(
  config: PostgresDatabaseConfig,
  provider?: MigrationProvider,
): Promise<{ db: Kysely<Database>; migrationsApplied: string[] }> {
  const db = openPostgresDatabase(config);
  try {
    await assertPostgresReachable(db, config);
    const { executed } = await migrateToLatest(db, provider);
    return { db, migrationsApplied: executed };
  } catch (error) {
    // Closing is best effort: a failure here must not hide the error that caused it.
    await db.destroy().catch(() => undefined);
    throw error;
  }
}
