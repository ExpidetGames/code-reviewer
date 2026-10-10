// Puts a backup back as the live database. The app must be stopped: this replaces the file the app
// has open.
//
// Order of events, chosen so that a problem found early changes nothing:
//   1. the backup is checked (`PRAGMA integrity_check`); a missing or damaged one stops here,
//   2. it is copied next to the database under a temporary name and checked again (a copy that
//      went wrong must not become the database),
//   3. the current database, with its -wal and -shm files, is moved aside under a name that carries
//      the time (never deleted: if the restore was a mistake, the old data is still there),
//   4. the copy gets the name of the database.
// The -wal and -shm of the old database must move with it: SQLite would replay a log that belongs to
// another file into the restored one. If step 4 fails, step 3 is undone.
//
// No `server-only` import: the command line (cli.ts) runs this code without Next.js.
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BackupError, describeError, errorCode } from "./errors.ts";
import { TEMP_FILE_PREFIX, TEMP_FILE_SUFFIX } from "./names.ts";
import { integrityProblem } from "./verify.ts";

export type RestoreOptions = {
  /** The backup file to restore. */
  backupPath: string;
  /** The live database to replace, normally DATABASE_PATH. */
  databasePath: string;
  now?: () => Date;
  /** Steps a test can reach into; production code passes nothing. */
  hooks?: { afterOldDatabaseMoved?: () => void };
};

export type RestoreResult = {
  databasePath: string;
  /** Where the replaced database now lives, or null when there was none. */
  previousKeptAs: string | null;
};

const SIDE_FILES = ["", "-wal", "-shm"] as const;

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
  let moved: Array<{ from: string; to: string }> = [];
  try {
    copyFileSync(backupPath, temporaryPath, constants.COPYFILE_EXCL);
    const copyProblem = integrityProblem(temporaryPath);
    if (copyProblem !== null)
      throw new BackupError(
        "RESTORE_FAILED",
        `The copy of the backup failed the integrity check (${copyProblem}); nothing was restored.`,
      );
    makePrivate(temporaryPath);

    const stamp = stampOf(now());
    moved = moveAside(databasePath, stamp);
    options.hooks?.afterOldDatabaseMoved?.();
    renameSync(temporaryPath, databasePath);
    return {
      databasePath,
      previousKeptAs:
        moved.find((entry) => entry.from === databasePath)?.to ?? null,
    };
  } catch (error) {
    undoMoves(moved);
    removeQuietly(temporaryPath);
    throw error instanceof BackupError
      ? error
      : new BackupError(
          "RESTORE_FAILED",
          `Restoring into "${dataDir}" failed (${errorCode(error) ?? "error"}): ${describeError(error)}. The previous database was put back.`,
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

// A restored database holds sessions and tokens: readable by its owner only, like every backup.
function makePrivate(path: string): void {
  chmodSync(path, 0o600);
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function stampOf(at: Date): string {
  // 2026-10-11T08:00:00.000Z -> 20261011T080000Z
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function moveAside(
  databasePath: string,
  stamp: string,
): Array<{ from: string; to: string }> {
  const moved: Array<{ from: string; to: string }> = [];
  for (const side of SIDE_FILES) {
    const from = `${databasePath}${side}`;
    if (!existsSync(from)) continue;
    const to = `${from}.before-restore-${stamp}`;
    renameSync(from, to);
    moved.push({ from, to });
  }
  return moved;
}

function undoMoves(moved: Array<{ from: string; to: string }>): void {
  for (const { from, to } of [...moved].reverse()) {
    try {
      renameSync(to, from);
    } catch {
      // Nothing more can be done; the message of the original error tells where the files are.
    }
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Not created yet, or already gone.
  }
}
