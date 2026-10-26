// SPDX-License-Identifier: LicenseRef-Proprietary

// The connection of this process: the Postgres pool opens on the first `getDatabase()` call and is shared by
// everything that runs in this instance afterwards. The schema is migrated by `pnpm migrate`, never by the app
// (the instance only reports a database that is behind, on /api/health).
import "server-only";
import type { Kysely } from "kysely";
import { loadDatabaseConfig } from "./config.ts";
import { openPostgresDatabase } from "./postgres.ts";
import type { Database } from "./schema.ts";

// One connection per instance. The global survives module reloads in `next dev` and is shared between the
// bundles of the routes, which do not share modules.
const globalKey = Symbol.for("code-reviewer.database");
type GlobalWithDatabase = typeof globalThis & {
  [globalKey]?: Kysely<Database>;
};

/**
 * The connection of this instance: a pool that connects on its first query, opened here on the first call.
 */
export function getDatabase(): Kysely<Database> {
  const holder = globalThis as GlobalWithDatabase;
  const db = holder[globalKey];
  if (db) return db;
  const opened = openPostgresDatabase(loadDatabaseConfig(process.env));
  holder[globalKey] = opened;
  return opened;
}

/** Closes the connection of this instance, if one was opened. */
export async function closeDatabase(): Promise<void> {
  const holder = globalThis as GlobalWithDatabase;
  const db = holder[globalKey];
  delete holder[globalKey];
  await db?.destroy();
}
