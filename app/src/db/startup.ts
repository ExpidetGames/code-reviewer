// What happens when the app server starts: open the database (creating the file if needed), bring
// the schema to the latest version, and keep the connection for the rest of the process.
// `instrumentation.ts` calls initializeDatabaseOnStart; everything else here is testable on its own.
import "server-only";
import type { Kysely } from "kysely";
import { loadDatabaseConfig, type DatabaseConfig } from "./config.ts";
import { openDatabase } from "./connection.ts";
import { DatabaseError } from "./errors.ts";
import type { MigrationProvider } from "kysely/migration";
import { migrateToLatest } from "./migrate.ts";
import type { Database } from "./schema.ts";

/** Opens the database and migrates it. Closes the connection again when that fails. */
export async function startDatabase(
  config: DatabaseConfig,
  provider?: MigrationProvider,
): Promise<{ db: Kysely<Database>; migrationsApplied: string[] }> {
  const db = openDatabase(config);
  try {
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
type GlobalWithDatabase = typeof globalThis & { [globalKey]?: Kysely<Database> };

/** The connection opened at startup. Fails loudly when the server did not start the database. */
export function getDatabase(): Kysely<Database> {
  const db = (globalThis as GlobalWithDatabase)[globalKey];
  if (!db) throw new Error("The database is not initialized: it is opened when the server starts.");
  return db;
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
    const { db, migrationsApplied } = await startDatabase(loadDatabaseConfig(env), migrations);
    // A second start in the same process (a reloaded module in `next dev`) must not leak the first.
    await closeDatabase();
    (globalThis as GlobalWithDatabase)[globalKey] = db;
    if (migrationsApplied.length > 0) {
      console.info(`[database] applied migrations: ${migrationsApplied.join(", ")}`);
    }
  } catch (error) {
    if (!(error instanceof DatabaseError)) throw error;
    log(`[database] ${error.code}: ${error.message}`);
    exit(1);
  }
}
