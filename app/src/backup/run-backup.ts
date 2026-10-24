// SPDX-License-Identifier: LicenseRef-Proprietary

// The backup job: one backup, then the rotation. This is what the scheduler in the app and the
// command line (cli.ts, for a Coolify scheduled task or a manual run) both call.
//
// The rotation runs only after a successful backup, so a failing backup can never shrink the
// history. Every outcome is logged in one or two lines that name the file's path and size or an
// error code and a message; nothing from the database ever reaches the log.
import { BackupError } from "./errors.ts";
import { createBackup, type BackupResult } from "./create-backup.ts";
import { rotateBackups } from "./rotate.ts";
import type { RetentionRule } from "./retention.ts";

export type BackupLog = {
  info: (message: string) => void;
  error: (message: string) => void;
};

export type BackupJobOutcome =
  | {
      ok: true;
      backup: BackupResult;
      /** Backups the rotation deleted. */
      removed: string[];
      /** Set when the rotation had a problem; the backup itself is fine. */
      rotationProblem: string | null;
    }
  | { ok: false; error: BackupError };

export function runBackupJob({
  databasePath,
  backupDir,
  now = () => new Date(),
  busyTimeoutMs,
  retention,
  log = { info: console.info, error: console.error },
}: {
  databasePath: string;
  backupDir: string;
  now?: () => Date;
  busyTimeoutMs?: number;
  retention?: RetentionRule;
  log?: BackupLog;
}): BackupJobOutcome {
  let backup: BackupResult;
  try {
    backup = createBackup({ databasePath, backupDir, now, busyTimeoutMs });
  } catch (error) {
    const failure =
      error instanceof BackupError
        ? error
        : new BackupError("BACKUP_WRITE_FAILED", String(error), {
            cause: error,
          });
    log.error(`[backup] ${failure.code}: ${failure.message}`);
    return { ok: false, error: failure };
  }
  log.info(`[backup] created ${backup.path} (${String(backup.bytes)} bytes)`);

  const rotation = rotateBackups({ backupDir, now: now(), rule: retention });
  for (const name of rotation.removed) log.info(`[backup] removed ${name}`);
  if (rotation.problem !== null)
    log.error(
      `[backup] rotation incomplete (${String(rotation.failed.length)} old backups kept): ${rotation.problem}`,
    );
  return {
    ok: true,
    backup,
    removed: rotation.removed,
    rotationProblem: rotation.problem,
  };
}
