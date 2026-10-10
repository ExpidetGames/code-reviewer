// What happens when the app server starts: open the database (creating the file if needed), bring
// the schema to the latest version, and keep the connection for the rest of the process.
// `instrumentation.ts` calls initializeDatabaseOnStart; everything else here is testable on its own.
import type { Kysely } from "kysely";
import { loadDatabaseConfig, type DatabaseConfig } from "./config.ts";
import { openDatabase } from "./connection.ts";
import { DatabaseError } from "./errors.ts";
import { migrateToLatest } from "./migrate.ts";
import type { Database } from "./schema.ts";

/** Opens the database and migrates it. Closes the connection again when that fails. */
export async function startDatabase(
  config: DatabaseConfig,
): Promise<{ db: Kysely<Database>; migrationsApplied: string[] }> {
  const db = openDatabase(config);
  try {
    const { executed } = await migrateToLatest(db);
    return { db, migrationsApplied: executed };
  } catch (error) {
    await db.destroy();
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

type StartOptions = {
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
  env = process.env,
  log = console.error,
  exit = (code) => process.exit(code),
}: StartOptions = {}): Promise<void> {
  try {
    const { db, migrationsApplied } = await startDatabase(loadDatabaseConfig(env));
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
