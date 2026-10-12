// SPDX-License-Identifier: Apache-2.0

// The backup that comes first when an installation from before accounts starts on the new version
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.11, point 1). It is taken BEFORE the migrations,
// so the file it holds is the database exactly as the previous release left it: restoring it and starting the
// previous release again is the way back. The import does not run, and the migrations do not start, if the
// backup fails; the reason is logged and the start ends. It lies outside the import's transaction, so a start that
// runs the import again (after a failure) takes another backup, which is harmless.
//
// "An installation that is about to be imported" is the same question the import asks, answered with a plain
// read of the file because the schema may be the old one: users exist, the first-run setup has not finished and
// the import has not run. A database with no users (a fresh installation, or no file at all) needs no backup.
//
// No `server-only` import: the check is plain better-sqlite3, like the rest of src/backup/.
import BetterSqlite3 from "better-sqlite3";
import { existsSync } from "node:fs";
import { loadBackupPaths } from "../backup/config.ts";
import { runBackupJob, type BackupLog } from "../backup/run-backup.ts";

type Env = Readonly<Record<string, string | undefined>>;

function settingValue(db: BetterSqlite3.Database, key: string): unknown {
  const row = db
    .prepare("select value from instance_settings where key = ?")
    .get(key) as { value: string } | undefined;
  if (row === undefined) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Whether the database file at `databasePath` is an existing installation whose import has not run: it has
 * users, and neither `setup_completed_at` nor `import_state` `done` is set. Only reads; false when the
 * file does not exist.
 */
export function holdsInstallationToImport(databasePath: string): boolean {
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
    if (!tables.has("users")) return false;
    if (db.prepare("select 1 from users limit 1").get() === undefined)
      return false;
    if (!tables.has("instance_settings")) return true;
    if (settingValue(db, "setup_completed_at") != null) return false;
    return settingValue(db, "import_state") !== "done";
  } finally {
    db.close();
  }
}

export type BackupBeforeUpdateOptions = {
  env?: Env;
  log?: BackupLog;
  exit?: (code: number) => void;
  now?: () => Date;
};

/**
 * Takes the backup when an installation is about to be imported, and ends the start when it fails. Returns
 * whether a backup was taken.
 */
export function backupBeforeUpdateOnStart({
  env = process.env,
  log = { info: console.info, error: console.error },
  exit = (code) => process.exit(code),
  now,
}: BackupBeforeUpdateOptions = {}): boolean {
  const { databasePath, backupDir } = loadBackupPaths(env);
  let needed: boolean;
  try {
    needed = holdsInstallationToImport(databasePath);
  } catch {
    // A file that cannot be read is the database layer's to report, with its own words, in a moment.
    return false;
  }
  if (!needed) return false;
  log.info(
    "[update] BACKUP_BEFORE_UPDATE: this database was made by a version before accounts. It is backed up first, then migrated and imported.",
  );
  const outcome = runBackupJob({
    databasePath,
    backupDir,
    now,
    log,
    // The same retention as every backup of the app; a failed rotation never hides a good backup.
  });
  if (!outcome.ok) {
    log.error(
      "[update] UPDATE_BACKUP_FAILED: the backup before the update could not be taken, so the update did not start and the database was not changed. Fix the backup target (BACKUP_DIR: the volume must be mounted and writable) and start again.",
    );
    exit(1);
    return false;
  }
  return true;
}
