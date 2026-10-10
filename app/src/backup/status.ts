// The picture of the backups that the status route serves: schedule, target, last scheduled run and
// the newest backup found in the directory. Reads the directory each time, so it stays true after a
// restart of the app and after a backup made by hand.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatBackupTime, type BackupConfig } from "./config.ts";
import { assertBackupTargetUsable } from "./create-backup.ts";
import { BackupError, type BackupErrorCode } from "./errors.ts";
import { parseBackupFileName } from "./names.ts";
import type { BackupRunRecord } from "./run-state.ts";

/** A day and a half: one missed run is tolerated, two in a row are not. */
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export type BackupStatus = {
  schedule: { enabled: boolean; timeUtc: string | null };
  target: { usable: boolean; errorCode: BackupErrorCode | null };
  lastRun: BackupRunRecord | null;
  newestBackup: { fileName: string; createdAt: string; bytes: number } | null;
  backupCount: number;
  /**
   * True when there is no backup younger than a day and a half, whoever makes them (the scheduler
   * of the app or a Coolify task): the directory is the truth, a task that fails every night shows here.
   */
  stale: boolean;
};

export function readBackupStatus({
  config,
  lastRun,
  now,
}: {
  config: BackupConfig;
  lastRun: BackupRunRecord | null;
  now: Date;
}): BackupStatus {
  const backups = listBackups(config.backupDir);
  const newest = backups[0];
  const enabled = config.time !== null;
  return {
    schedule: {
      enabled,
      timeUtc: config.time ? formatBackupTime(config.time) : null,
    },
    target: targetState(config),
    lastRun,
    newestBackup: newest
      ? {
          fileName: newest.fileName,
          createdAt: newest.at.toISOString(),
          bytes: newest.bytes,
        }
      : null,
    backupCount: backups.length,
    stale:
      newest === undefined ||
      now.getTime() - newest.at.getTime() > STALE_AFTER_MS,
  };
}

function targetState(config: BackupConfig): BackupStatus["target"] {
  try {
    assertBackupTargetUsable(config.backupDir, config.databasePath);
    return { usable: true, errorCode: null };
  } catch (error) {
    return {
      usable: false,
      errorCode:
        error instanceof BackupError ? error.code : "BACKUP_TARGET_UNAVAILABLE",
    };
  }
}

/** The backup files of the directory, newest first. An unreadable directory has none. */
function listBackups(
  backupDir: string,
): Array<{ fileName: string; at: Date; bytes: number }> {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return [];
  }
  return names
    .flatMap((fileName) => {
      const parsed = parseBackupFileName(fileName);
      if (!parsed) return [];
      try {
        return [
          {
            fileName,
            at: parsed.at,
            sequence: parsed.sequence,
            bytes: statSync(join(backupDir, fileName)).size,
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.sequence - a.sequence);
}
