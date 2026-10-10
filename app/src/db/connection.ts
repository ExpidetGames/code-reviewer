// Opens the SQLite file and applies the connection settings every part of the app relies on:
// the busy timeout (set first, so even the switch to WAL waits for a lock instead of failing),
// WAL mode, and enforced foreign keys.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely } from "kysely";
import type { DatabaseConfig } from "./config.ts";
import { AppSqliteDialect } from "./dialect.ts";
import { DatabaseError } from "./errors.ts";
import type { Database } from "./schema.ts";

export function openDatabase(config: DatabaseConfig): Kysely<Database> {
  assertDirectoryUsable(config.path);

  let sqlite: BetterSqlite3.Database | undefined;
  try {
    sqlite = new BetterSqlite3(config.path, { timeout: config.busyTimeoutMs });
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
  } catch (cause) {
    sqlite?.close();
    throw new DatabaseError(
      "DATABASE_OPEN_FAILED",
      `Cannot open the SQLite database at "${config.path}": ${describe(cause)}`,
      { cause },
    );
  }

  return new Kysely<Database>({ dialect: new AppSqliteDialect({ database: sqlite }) });
}

// The file itself is created on first open, the directory is not: a wrong DATABASE_PATH (or a volume
// that was not mounted) must stop the start with a message instead of silently writing elsewhere.
function assertDirectoryUsable(databasePath: string): void {
  const directory = dirname(databasePath);
  const unusable = (reason: string) =>
    new DatabaseError(
      "DATABASE_DIRECTORY_UNAVAILABLE",
      `The database directory "${directory}" (from DATABASE_PATH="${databasePath}") ${reason}. ` +
        "Create it and make it writable, or point DATABASE_PATH to another location.",
    );

  if (!existsSync(directory)) throw unusable("does not exist");
  if (!statSync(directory).isDirectory()) throw unusable("is not a directory");
  try {
    accessSync(directory, constants.W_OK);
  } catch {
    throw unusable("is not writable");
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
