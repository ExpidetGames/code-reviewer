// One backup run: a consistent, verified copy of the SQLite database in the backup directory.
//
// A plain copy of a live WAL database is not a backup: the newest writes may still be in the -wal
// file, and a copy taken while the app writes can mix old and new pages. `VACUUM INTO` reads the
// database inside one read transaction (writers keep working) and writes one compact file with
// everything that was committed when it started.
//
// The file is built under a temporary name in the target directory, verified with
// `PRAGMA integrity_check`, flushed to disk and only then given its final name, without ever
// replacing an existing file. So the directory holds either a complete backup or none, and a crash
// or a full disk leaves at most a temporary file that the next run removes.
//
// No `server-only` import: the command line (cli.ts) runs this code without Next.js.
import BetterSqlite3 from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  existsSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import {
  BackupError,
  describeError,
  errorCode,
  type BackupErrorCode,
} from "./errors.ts";
import {
  TEMP_FILE_PREFIX,
  TEMP_FILE_SUFFIX,
  backupFileName,
  isTempFileName,
} from "./names.ts";
import { integrityProblem } from "./verify.ts";

export const DEFAULT_SOURCE_BUSY_TIMEOUT_MS = 10_000;
// A temporary file older than this belongs to a run that died; a run that is still going is younger.
const STALE_TEMP_FILE_MS = 60 * 60 * 1000;
const MAX_SEQUENCE = 1000;

export type CreateBackupOptions = {
  /** The live database, normally DATABASE_PATH. */
  databasePath: string;
  /** The directory the backup goes to; it must exist and lie outside the database's directory. */
  backupDir: string;
  now?: () => Date;
  /** How long to wait for a lock on the source before giving up. */
  busyTimeoutMs?: number;
  /** Steps a test can reach into; production code passes nothing. */
  hooks?: {
    /** Runs when the temporary file is written, before it is verified. */
    afterWrite?: (temporaryPath: string) => void;
    /** Runs when the temporary file is verified, right before it gets its final name. */
    beforePublish?: (temporaryPath: string) => void;
  };
};

export type BackupResult = {
  fileName: string;
  path: string;
  bytes: number;
  createdAt: Date;
};

export function createBackup(options: CreateBackupOptions): BackupResult {
  const { databasePath, backupDir } = options;
  const now = options.now ?? (() => new Date());
  const createdAt = now();

  assertSourceExists(databasePath);
  assertBackupTargetUsable(backupDir, databasePath);
  removeStaleTemporaryFiles(backupDir, createdAt);

  const temporaryPath = join(
    backupDir,
    `${TEMP_FILE_PREFIX}${randomBytes(6).toString("hex")}${TEMP_FILE_SUFFIX}`,
  );
  try {
    createPrivateFile(temporaryPath);
    vacuumInto(
      databasePath,
      temporaryPath,
      options.busyTimeoutMs ?? DEFAULT_SOURCE_BUSY_TIMEOUT_MS,
    );
    callHook(options.hooks?.afterWrite, temporaryPath);
    const problem = integrityProblem(temporaryPath);
    if (problem !== null)
      throw new BackupError(
        "BACKUP_VERIFY_FAILED",
        `The new backup failed the integrity check and was discarded: ${problem}`,
      );
    flushToDisk(temporaryPath);
    callHook(options.hooks?.beforePublish, temporaryPath);
    const path = publish(temporaryPath, backupDir, createdAt);
    return {
      fileName: basename(path),
      path,
      bytes: statSync(path).size,
      createdAt,
    };
  } catch (error) {
    removeQuietly(temporaryPath);
    throw error instanceof BackupError
      ? error
      : new BackupError(
          "BACKUP_WRITE_FAILED",
          `Writing the backup to "${backupDir}" failed (${errorCode(error) ?? "error"}): ${describeError(error)}`,
          { cause: error },
        );
  }
}

function assertSourceExists(databasePath: string): void {
  try {
    if (statSync(databasePath).isFile()) return;
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR")
      throw new BackupError(
        "BACKUP_SOURCE_INVALID",
        `The database "${databasePath}" cannot be read (${errorCode(error) ?? "error"}): ${describeError(error)}`,
        { cause: error },
      );
    throw new BackupError(
      "BACKUP_SOURCE_MISSING",
      `The database "${databasePath}" does not exist. Check DATABASE_PATH.`,
    );
  }
  throw new BackupError(
    "BACKUP_SOURCE_INVALID",
    `The database "${databasePath}" is not a file.`,
  );
}

/** Throws BACKUP_TARGET_UNAVAILABLE or BACKUP_TARGET_INSIDE_DATA unless backups can be written to `backupDir`. */
export function assertBackupTargetUsable(
  backupDir: string,
  databasePath: string,
): void {
  let resolved: string;
  try {
    if (!statSync(backupDir).isDirectory())
      throw new BackupError(
        "BACKUP_TARGET_UNAVAILABLE",
        `The backup target "${backupDir}" is not a directory.`,
      );
    accessSync(backupDir, constants.W_OK);
    resolved = realpathSync(backupDir);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    const reason =
      errorCode(error) === "ENOENT"
        ? "does not exist"
        : `cannot be written to (${errorCode(error) ?? "error"})`;
    throw new BackupError(
      "BACKUP_TARGET_UNAVAILABLE",
      `The backup target "${backupDir}" ${reason}. Create it, mount the backup volume, or fix its permissions.`,
      { cause: error },
    );
  }
  const dataDir = realpathSync(dirname(databasePath));
  if (resolved === dataDir || resolved.startsWith(dataDir + sep))
    throw new BackupError(
      "BACKUP_TARGET_INSIDE_DATA",
      `The backup target "${backupDir}" lies inside the database directory "${dataDir}". A backup next to the data is lost with it: use a separate volume.`,
    );
}

// Runs of earlier processes that died between creating and publishing a file leave a temporary one.
function removeStaleTemporaryFiles(backupDir: string, now: Date): void {
  try {
    for (const name of readdirSync(backupDir)) {
      if (!isTempFileName(name)) continue;
      const path = join(backupDir, name);
      if (now.getTime() - statSync(path).mtimeMs > STALE_TEMP_FILE_MS)
        removeQuietly(path);
    }
  } catch {
    // A directory that cannot be listed is reported by the real work that follows.
  }
}

// Created here, with mode 0600 from the start, so that the data is never readable by others, not
// even briefly. `VACUUM INTO` accepts an existing empty file.
function createPrivateFile(path: string): void {
  closeSync(openSync(path, "wx", 0o600));
}

function vacuumInto(
  databasePath: string,
  temporaryPath: string,
  busyTimeoutMs: number,
): void {
  let source: BetterSqlite3.Database | undefined;
  try {
    source = new BetterSqlite3(databasePath, {
      fileMustExist: true,
      timeout: busyTimeoutMs,
    });
    source.prepare("VACUUM INTO ?").run(temporaryPath);
  } catch (error) {
    throw new BackupError(
      sourceFailureCode(errorCode(error)),
      `Reading the database "${databasePath}" failed (${errorCode(error) ?? "error"}): ${describeError(error)}`,
      { cause: error },
    );
  } finally {
    source?.close();
  }
}

function sourceFailureCode(code: string | undefined): BackupErrorCode {
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED")
    return "BACKUP_SOURCE_LOCKED";
  if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT")
    return "BACKUP_SOURCE_INVALID";
  // Anything else (a full disk, an I/O error while writing the copy) is a failure to write.
  return "BACKUP_WRITE_FAILED";
}

function callHook(
  hook: ((temporaryPath: string) => void) | undefined,
  temporaryPath: string,
): void {
  hook?.(temporaryPath);
}

function flushToDisk(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Gives the temporary file its final name without replacing anything: a hard link fails if the name
// is taken, then the temporary name is dropped. Where the file system has no hard links, an
// existence check and a rename do the same job.
function publish(temporaryPath: string, backupDir: string, at: Date): string {
  for (let sequence = 1; sequence <= MAX_SEQUENCE; sequence += 1) {
    const path = join(backupDir, backupFileName(at, sequence));
    try {
      linkSync(temporaryPath, path);
      unlinkSync(temporaryPath);
      return path;
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      if (!HARD_LINKS_UNSUPPORTED.has(errorCode(error) ?? "")) throw error;
    }
    if (existsSync(path)) continue;
    renameSync(temporaryPath, path);
    return path;
  }
  throw new BackupError(
    "BACKUP_WRITE_FAILED",
    `Could not find a free backup name for ${at.toISOString()} in "${backupDir}".`,
  );
}

const HARD_LINKS_UNSUPPORTED = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EXDEV",
]);

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove; the original error is what matters.
  }
}
