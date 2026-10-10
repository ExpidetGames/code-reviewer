// Opens the SQLite file and applies the connection settings every part of the app relies on:
// the busy timeout (set first, so even the switch to WAL waits for a lock instead of failing),
// WAL mode, and enforced foreign keys.
import "server-only";
import { accessSync, constants, statSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely } from "kysely";
import type { DatabaseConfig } from "./config.ts";
import { AppSqliteDialect } from "./dialect.ts";
import { DatabaseError, describeError, errorCode } from "./errors.ts";
import type { Database } from "./schema.ts";

export function openDatabase(config: DatabaseConfig): Kysely<Database> {
  assertDirectoryUsable(config.path);

  let sqlite: BetterSqlite3.Database | undefined;
  try {
    sqlite = new BetterSqlite3(config.path, { timeout: config.busyTimeoutMs });
    const opened = sqlite;
    retryWhileBusy(config.busyTimeoutMs, () => enableWal(opened));
    sqlite.pragma("foreign_keys = ON");
  } catch (cause) {
    sqlite?.close();
    throw new DatabaseError(
      "DATABASE_OPEN_FAILED",
      `Cannot open the SQLite database at "${config.path}": ${describeError(cause)}`,
      { cause },
    );
  }

  return new Kysely<Database>({ dialect: new AppSqliteDialect({ database: sqlite }) });
}

// SQLite answers `pragma journal_mode = WAL` with the mode it ended up in. An in-memory database or
// a file system without shared memory silently stays in another mode; the busy timeout reasoning
// and the README assume WAL, so that is a failure to open, not something to run with.
function enableWal(sqlite: BetterSqlite3.Database): void {
  const result = sqlite.pragma("journal_mode = WAL") as Array<{ journal_mode?: string }>;
  const mode = result[0]?.journal_mode;
  if (mode !== "wal") throw new Error(`WAL mode could not be enabled (journal mode is "${mode}")`);
}

// The file itself is created on first open, the directory is not: a wrong DATABASE_PATH (or a volume
// that was not mounted) must stop the start with a message instead of silently writing elsewhere.
// Every file system problem is mapped here, so that the start never ends with a raw errno error.
function assertDirectoryUsable(databasePath: string): void {
  const directory = dirname(databasePath);
  const problem = directoryProblem(directory);
  if (!problem) return;
  throw new DatabaseError(
    "DATABASE_DIRECTORY_UNAVAILABLE",
    `The database directory "${directory}" (from DATABASE_PATH="${databasePath}") ${problem}. ` +
      "Create it and make it writable, or point DATABASE_PATH to another location.",
  );
}

function directoryProblem(directory: string): string | undefined {
  try {
    if (!statSync(directory).isDirectory()) return "is not a directory";
    accessSync(directory, constants.W_OK);
    return undefined;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return "does not exist";
    if (code === "ENOTDIR") return "is not a directory";
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return "cannot be written to (permission denied or read-only)";
    }
    return `cannot be used (${code ?? "unknown error"}: ${describeError(error)})`;
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
      if (errorCode(error) !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
