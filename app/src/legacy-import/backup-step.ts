// SPDX-License-Identifier: Apache-2.0

// The backup that comes first when an installation from before accounts starts on the new version
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.11, point 1). It is taken BEFORE the migrations,
// so the file it holds is the database exactly as the previous release left it: restoring it and starting the
// previous release again is the way back. The import does not run, and the migrations do not start, if the
// backup fails; the reason is logged and the start ends.
//
// It is taken ONLY while the schema is still the previous release's (the table `workspaces` does not exist yet).
// A start after the migrations ran (a failed import, a crash, `restart: unless-stopped` looping on a persistent
// failure) takes none: a copy of the migrated schema cannot be started by the previous release, and one copy per
// restart would fill the disk. For the same reason the file is renamed to
// `code-reviewer-before-update-<UTC time>.db`: the retention rule of the daily backup (src/backup/retention.ts)
// only knows `code-reviewer-<time>.db`, so it never deletes the way back; the operator removes the file when the
// update is settled. If the migrations fail and roll back, the schema is still the previous one; a start then
// takes no second backup while a backup of this update exists that is newer than the database file.
//
// "An installation of the previous release" is: users exist and the table `workspaces` does not. A database with
// no users (a fresh installation, or no file at all) needs no backup.
//
// No `server-only` import: the check is plain better-sqlite3, like the rest of src/backup/. The file system calls
// with a path that is only known at run time carry `turbopackIgnore`, like the ones in src/backup/create-backup.ts:
// without it Turbopack traces the whole project into the standalone output of the image.
import BetterSqlite3 from "better-sqlite3";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadBackupPaths } from "../backup/config.ts";
import { createBackup } from "../backup/create-backup.ts";
import { BackupError } from "../backup/errors.ts";
import { renameNoOverwrite } from "../backup/fs-util.ts";
import { backupFileName } from "../backup/names.ts";
import type { BackupLog } from "../backup/run-backup.ts";

type Env = Readonly<Record<string, string | undefined>>;

const BEFORE_UPDATE_PREFIX = "code-reviewer-before-update-";
const BEFORE_UPDATE_NAME =
  /^code-reviewer-before-update-\d{8}T\d{6}Z(?:-\d+)?\.db$/;

/** Whether a file name is that of a backup taken by the update (never touched by the retention rule). */
export function isBeforeUpdateBackupName(name: string): boolean {
  return BEFORE_UPDATE_NAME.test(name);
}

/**
 * Whether the database file at `databasePath` is an installation of the previous release: it has users and
 * the table `workspaces` (the first migration of accounts) does not exist yet. Only reads; false when the file
 * does not exist.
 */
export function holdsDatabaseOfThePreviousRelease(
  databasePath: string,
): boolean {
  if (!existsSync(databasePath)) return false;
  // A normal connection that only reads: a read-only one cannot always open a write-ahead log that the
  // previous release left behind.
  const db = new BetterSqlite3(databasePath, {
    fileMustExist: true,
    timeout: 5000,
  });
  try {
    const tables = new Set(
      (
        db
          .prepare("select name from sqlite_master where type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    if (!tables.has("users") || tables.has("workspaces")) return false;
    return db.prepare("select 1 from users limit 1").get() !== undefined;
  } finally {
    db.close();
  }
}

/** The newest time the database was written: the file and its write-ahead log. */
function lastWritten(databasePath: string): number {
  return Math.max(
    ...[databasePath, `${databasePath}-wal`]
      .filter((path) => existsSync(/* turbopackIgnore: true */ path))
      .map((path) => statSync(/* turbopackIgnore: true */ path).mtimeMs),
  );
}

/** A backup of this update (not rotated) that is newer than the database, or null. */
function keptBackupOfThisUpdate(
  databasePath: string,
  backupDir: string,
): string | null {
  let names: string[];
  try {
    names = readdirSync(/* turbopackIgnore: true */ backupDir).filter(
      isBeforeUpdateBackupName,
    );
  } catch {
    return null;
  }
  const written = lastWritten(databasePath);
  return (
    names.find(
      (name) =>
        statSync(/* turbopackIgnore: true */ join(backupDir, name)).mtimeMs >=
        written,
    ) ?? null
  );
}

export type BackupBeforeUpdateOptions = {
  env?: Env;
  log?: BackupLog;
  exit?: (code: number) => void;
  now?: () => Date;
};

/**
 * Takes the backup when a database of the previous release is about to be updated, and ends the start when it
 * fails. Returns whether a backup was taken.
 */
export function backupBeforeUpdateOnStart({
  env = process.env,
  log = { info: console.info, error: console.error },
  exit = (code) => process.exit(code),
  now = () => new Date(),
}: BackupBeforeUpdateOptions = {}): boolean {
  const { databasePath, backupDir } = loadBackupPaths(env);
  let needed: boolean;
  try {
    needed = holdsDatabaseOfThePreviousRelease(databasePath);
  } catch {
    // A file that cannot be read is the database layer's to report, with its own words, in a moment.
    return false;
  }
  if (!needed) return false;
  const kept = keptBackupOfThisUpdate(databasePath, backupDir);
  if (kept !== null) {
    log.info(
      `[update] BACKUP_BEFORE_UPDATE_KEPT: the backup of this update, ${backupDir}/${kept}, is newer than the database, so no second one is taken.`,
    );
    return false;
  }
  log.info(
    "[update] BACKUP_BEFORE_UPDATE: this database was made by a version before accounts. It is backed up first, then migrated and imported.",
  );
  try {
    const backup = createBackup({ databasePath, backupDir, now });
    // Out of the reach of the retention rule of the daily backup: this file is the way back.
    const keptName = backupFileName(backup.createdAt, 1).replace(
      /^code-reviewer-/,
      BEFORE_UPDATE_PREFIX,
    );
    const keptPath = join(backupDir, keptName);
    const renamed = renameNoOverwrite(backup.path, keptPath);
    log.info(
      `[backup] created ${renamed ? keptPath : backup.path} (${String(backup.bytes)} bytes), the way back to the previous version: keep it until the update is settled`,
    );
  } catch (error) {
    const failure =
      error instanceof BackupError
        ? error
        : new BackupError("BACKUP_WRITE_FAILED", String(error), {
            cause: error,
          });
    log.error(`[backup] ${failure.code}: ${failure.message}`);
    log.error(
      "[update] UPDATE_BACKUP_FAILED: the backup before the update could not be taken, so the update did not start and the database was not changed. Fix the backup target (BACKUP_DIR: the volume must be mounted and writable) and start again.",
    );
    exit(1);
    return false;
  }
  return true;
}
