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
    retryWhileBusy(config.busyTimeoutMs, () => sqlite?.pragma("journal_mode = WAL"));
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

// Switching a brand-new file to WAL while another process does the same fails at once with
// SQLITE_BUSY: SQLite refuses to wait there because waiting could deadlock, so the busy timeout
// does not apply. Retrying is the documented way out. It happens once per file (WAL is stored in
// the file), only at startup, and gives up after the busy timeout like any other lock wait.
function retryWhileBusy(timeoutMs: number, action: () => void): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return action();
    } catch (error) {
      const busy = error instanceof Error && "code" in error && error.code === "SQLITE_BUSY";
      if (!busy || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
