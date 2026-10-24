// SPDX-License-Identifier: LicenseRef-Proprietary

// Puts a backup back as the live database. The app must be stopped: this replaces the file the app
// has open. A database that another process still has open is refused (step 3).
//
// Order of events, chosen so that a problem found early changes nothing:
//   1. the backup is checked (`PRAGMA integrity_check`); a missing or damaged one stops here,
//   2. it is copied next to the database under a temporary name, created readable by its owner only
//      before the first byte is written, and checked again (a copy that went wrong must not become
//      the database),
//   3. the current database must not be in use (exclusive locking mode succeeds only when no other
//      process has it open; a running app is refused),
//   4. the current database, with its -journal, -wal and -shm files, is moved aside under a name that carries
//      the time and never replaces an earlier one (never deleted: if the restore was a mistake, the
//      old data is still there),
//   5. the copy gets the name of the database.
// The -journal, -wal and -shm of the old database must move with it: SQLite would replay a log or a
// rollback journal that belongs to another file into the restored one. If step 5 fails, step 4 is
// undone.
//
// No `server-only` import: the command line (cli.ts) runs this code without Next.js.
import BetterSqlite3 from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BackupError, describeError, errorCode } from "./errors.ts";
import { removeQuietly, renameNoOverwrite } from "./fs-util.ts";
import { TEMP_FILE_PREFIX, TEMP_FILE_SUFFIX } from "./names.ts";
import { integrityProblem } from "./verify.ts";

export type RestoreOptions = {
  /** The backup file to restore. */
  backupPath: string;
  /** The live database to replace, normally DATABASE_PATH. */
  databasePath: string;
  now?: () => Date;
  /** Steps a test can reach into; production code passes nothing. */
  hooks?: {
    /** Runs before each file of the old database is moved aside. */
    beforeMove?: (path: string) => void;
    /** Runs right after the temporary copy is complete, before it is checked. */
    afterTemporaryCopyCreated?: (path: string) => void;
    afterOldDatabaseMoved?: () => void;
  };
};

export type RestoreResult = {
  databasePath: string;
  /** Where the replaced database now lives, or null when there was none. */
  previousKeptAs: string | null;
  /**
   * Every file moved aside: the old database and its side files, or only the side files (a leftover
   * -journal or -wal next to no database). Empty when there was nothing to move.
   */
  keptAside: string[];
};

// How long the in-use check waits for a lock before it decides the database is in use.
const IN_USE_TIMEOUT_MS = 1000;
// The database and everything SQLite keeps beside it: a rollback journal (a database that was in
// rollback mode when its process died) and a write-ahead log with its index (WAL mode).
const SIDE_FILES = ["", "-journal", "-wal", "-shm"] as const;
const COPY_CHUNK_BYTES = 1024 * 1024;

export function restoreBackup(options: RestoreOptions): RestoreResult {
  const { backupPath, databasePath } = options;
  const now = options.now ?? (() => new Date());

  assertBackupReadable(backupPath);
  const backupProblem = integrityProblem(backupPath);
  if (backupProblem !== null)
    throw new BackupError(
      "RESTORE_BACKUP_INVALID",
      `"${backupPath}" failed the integrity check and was not restored: ${backupProblem}. The current database is unchanged.`,
    );

  const dataDir = dirname(databasePath);
  assertDirectoryWritable(dataDir);

  const temporaryPath = join(
    dataDir,
    `${TEMP_FILE_PREFIX}restore-${randomBytes(6).toString("hex")}${TEMP_FILE_SUFFIX}`,
  );
  // Owned here, filled by moveAside one rename at a time: whatever was moved before a failure is
  // known to the undo below.
  const moved: Move[] = [];
  try {
    copyPrivately(backupPath, temporaryPath);
    options.hooks?.afterTemporaryCopyCreated?.(temporaryPath);
    const copyProblem = integrityProblem(temporaryPath);
    if (copyProblem !== null)
      throw new BackupError(
        "RESTORE_FAILED",
        `The copy of the backup failed the integrity check (${copyProblem}); nothing was restored.`,
      );

    assertNotInUse(databasePath);
    moveAside(databasePath, stampOf(now()), moved, options.hooks?.beforeMove);
    options.hooks?.afterOldDatabaseMoved?.();
    renameSync(temporaryPath, databasePath);
    return {
      databasePath,
      previousKeptAs:
        moved.find((entry) => entry.from === databasePath)?.to ?? null,
      keptAside: moved.map((entry) => entry.to),
    };
  } catch (error) {
    const notUndone = undoMoves(moved);
    removeQuietly(temporaryPath);
    if (error instanceof BackupError && notUndone.length === 0) throw error;
    const reason =
      error instanceof Error ? describeError(error) : String(error);
    throw new BackupError(
      "RESTORE_FAILED",
      `Restoring into "${dataDir}" failed (${errorCode(error) ?? "error"}): ${reason}. ` +
        (notUndone.length === 0
          ? "The previous database is in place."
          : `The previous database could not be put back completely; its files are: ${notUndone.map((move) => move.to).join(", ")}. Rename them back by hand before starting the app.`),
      { cause: error },
    );
  }
}

function assertBackupReadable(backupPath: string): void {
  try {
    if (statSync(backupPath).isFile()) return;
  } catch {
    throw new BackupError(
      "RESTORE_BACKUP_MISSING",
      `The backup file "${backupPath}" does not exist or cannot be read.`,
    );
  }
  throw new BackupError(
    "RESTORE_BACKUP_MISSING",
    `"${backupPath}" is not a file.`,
  );
}

function assertDirectoryWritable(dataDir: string): void {
  try {
    if (!statSync(dataDir).isDirectory()) throw new Error("not a directory");
    accessSync(dataDir, constants.W_OK);
  } catch (error) {
    throw new BackupError(
      "RESTORE_FAILED",
      `The data directory "${dataDir}" does not exist or cannot be written to (${errorCode(error) ?? describeError(error)}). Mount the data volume and make it writable for the app user.`,
      { cause: error },
    );
  }
}

// A restored database holds sessions and tokens: readable by its owner only, like every backup. The
// copy is created with mode 0600 (and never replaces a file) before any data is written, so no other
// local user can read a half-copied database, whatever the umask or the mode of the backup file;
// `copyFileSync` would give the copy the mode of its source. Flushed to disk before it returns.
function copyPrivately(sourcePath: string, targetPath: string): void {
  const source = openSync(sourcePath, "r");
  try {
    const target = openSync(targetPath, "wx", 0o600);
    try {
      // The mode given to `open` is cut by the umask, never widened; this makes it exact.
      fchmodSync(target, 0o600);
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (;;) {
        const read = readSync(source, chunk, 0, chunk.length, null);
        if (read === 0) break;
        let written = 0;
        while (written < read)
          written += writeSync(target, chunk, written, read - written);
      }
      fsyncSync(target);
    } finally {
      closeSync(target);
    }
  } finally {
    closeSync(source);
  }
}

function stampOf(at: Date): string {
  // 2026-10-11T08:00:00.000Z -> 20261011T080000Z
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export type Move = { from: string; to: string };

/**
 * Fails (RESTORE_FAILED) when another process has the database open, which is what a running app
 * is: the restore would replace the file under its feet, and its later writes would go to the old
 * database. Exclusive locking mode asks SQLite for the one thing an open connection of another
 * process prevents. A file that is not a database (a damaged one is a reason to restore) passes.
 */
function assertNotInUse(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  let sqlite: BetterSqlite3.Database | undefined;
  try {
    sqlite = new BetterSqlite3(databasePath, {
      fileMustExist: true,
      timeout: IN_USE_TIMEOUT_MS,
    });
    sqlite.pragma("locking_mode = EXCLUSIVE");
    sqlite.exec("begin immediate");
    sqlite.prepare("select count(*) from sqlite_master").get();
    sqlite.exec("rollback");
  } catch (error) {
    if (
      errorCode(error) !== "SQLITE_BUSY" &&
      errorCode(error) !== "SQLITE_LOCKED"
    )
      return;
    throw new BackupError(
      "RESTORE_FAILED",
      `The database "${databasePath}" is in use by another process. Stop the app first (and the runner, if it uses the same volume), then restore. Nothing was changed.`,
      { cause: error },
    );
  } finally {
    sqlite?.close();
  }
}

// Moves the old database and its -journal, -wal and -shm files to `<name>.before-restore-<time>`, with a
// number added when that name is taken (two restores in one second keep both). Every rename that
// happened is pushed to `moved` at once, so a later failure can undo the earlier ones.
/** Exported for its tests. */
export function moveAside(
  databasePath: string,
  stamp: string,
  moved: Move[],
  beforeMove: ((path: string) => void) | undefined,
): void {
  const present = SIDE_FILES.map((side) => `${databasePath}${side}`).filter(
    (path) => existsSync(path),
  );
  if (present.length === 0) return;
  for (let number = 1; ; number += 1) {
    const tag = `before-restore-${stamp}${number > 1 ? `-${String(number)}` : ""}`;
    if (present.some((path) => existsSync(`${path}.${tag}`))) continue;
    for (const from of present) {
      beforeMove?.(from);
      const to = `${from}.${tag}`;
      if (!renameNoOverwrite(from, to))
        throw new Error(`"${to}" appeared while the restore was running`);
      moved.push({ from, to });
    }
    return;
  }
}

/** Puts moved files back, newest move first. Returns the moves that could not be undone. */
/** Exported for its tests. */
export function undoMoves(moved: readonly Move[]): Move[] {
  const failed: Move[] = [];
  for (const move of [...moved].reverse()) {
    try {
      renameSync(move.to, move.from);
    } catch {
      failed.push(move);
    }
  }
  return failed;
}
