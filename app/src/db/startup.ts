// SPDX-License-Identifier: LicenseRef-Proprietary

// What happens when the app server starts: open the database (creating the file if needed), bring
// the schema to the latest version, and keep the connection for the rest of the process.
// `instrumentation.ts` calls initializeDatabaseOnStart; everything else here is testable on its own.
//
// Serverless mode (src/runtime/mode.ts) does none of that at start: `getDatabase()` opens the Postgres
// pool on its first call, and the schema is migrated by `pnpm migrate`, never by the app. This file
// imports `connection.ts` (and with it the SQLite driver, a native module) only when a server starts, so
// a serverless instance never loads it.
import "server-only";
import type { Kysely } from "kysely";
import {
  loadDatabaseConfig,
  type DatabaseConfig,
  type PostgresDatabaseConfig,
} from "./config.ts";
import { DatabaseError } from "./errors.ts";
import type { MigrationProvider } from "kysely/migration";
import { migrateToLatest } from "./migrate.ts";
import { assertPostgresReachable, openPostgresDatabase } from "./postgres.ts";
import type { Database } from "./schema.ts";
import { isServerless } from "../runtime/mode.ts";

/** Opens the database and migrates it. Closes the connection again when that fails. */
export async function startDatabase(
  config: DatabaseConfig,
  provider?: MigrationProvider,
): Promise<{ db: Kysely<Database>; migrationsApplied: string[] }> {
  const { openDatabase } = await import("./connection.ts");
  const db = openDatabase(config);
  try {
    if (config.driver === "postgres") await assertPostgresReachable(db, config);
    const { executed } = await migrateToLatest(db, provider);
    return { db, migrationsApplied: executed };
  } catch (error) {
    // Closing is best effort: a failure here must not hide the error that caused it.
    await db.destroy().catch(() => undefined);
    throw error;
  }
}

// One connection per server process. The global survives module reloads in `next dev` and is
// shared between the instrumentation bundle and the route bundles, which do not share modules.
const globalKey = Symbol.for("code-reviewer.database");
type GlobalWithDatabase = typeof globalThis & {
  [globalKey]?: Kysely<Database>;
};

/**
 * The connection of this process. A server opens it at start, so asking before that fails loudly.
 * A serverless instance opens it here, on the first call: a pool that connects on its first query,
 * shared by everything that runs in this instance afterwards.
 */
export function getDatabase(): Kysely<Database> {
  const holder = globalThis as GlobalWithDatabase;
  const db = holder[globalKey];
  if (db) return db;
  if (!isServerless())
    throw new Error(
      "The database is not initialized: it is opened when the server starts.",
    );
  // Serverless refuses anything but Postgres in loadDatabaseConfig; the cast states that.
  const opened = openPostgresDatabase(
    loadDatabaseConfig(process.env) as PostgresDatabaseConfig,
  );
  holder[globalKey] = opened;
  return opened;
}

/** Closes the connection opened at startup, if any. */
export async function closeDatabase(): Promise<void> {
  const holder = globalThis as GlobalWithDatabase;
  const db = holder[globalKey];
  delete holder[globalKey];
  await db?.destroy();
}

type StartOptions = {
  /** Replaces the built-in migrations; for tests. */
  migrations?: MigrationProvider;
  env?: Readonly<Record<string, string | undefined>>;
  log?: (message: string) => void;
  exit?: (code: number) => void;
};

/**
 * Called once when the server starts. A database problem ends the process with exit code 1 and one
 * readable line (the error code and what to do), not a stack trace; the app must not serve
 * requests without its schema. Anything unexpected is rethrown unchanged.
 */
export async function initializeDatabaseOnStart({
  migrations,
  env = process.env,
  log = console.error,
  exit = (code) => process.exit(code),
}: StartOptions = {}): Promise<void> {
  try {
    const { db, migrationsApplied } = await startDatabase(
      loadDatabaseConfig(env),
      migrations,
    );
    // A second start in the same process (a reloaded module in `next dev`) must not leak the first.
    await closeDatabase();
    (globalThis as GlobalWithDatabase)[globalKey] = db;
    if (migrationsApplied.length > 0) {
      console.info(
        `[database] applied migrations: ${migrationsApplied.join(", ")}`,
      );
    }
  } catch (error) {
    if (!(error instanceof DatabaseError)) throw error;
    log(`[database] ${error.code}: ${error.message}`);
    exit(1);
  }
}
