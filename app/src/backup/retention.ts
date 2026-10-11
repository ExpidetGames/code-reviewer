// Which backups to keep. Pure: file names and a clock in, two lists out; nothing here touches the
// disk, so the rule can be tested exhaustively.
//
// Kept are the union of
//   - the newest backup overall (the last way back is never deleted),
//   - every backup younger than `graceMs` (a manual backup before an upgrade stays for a day),
//   - the newest backup of each of the `daily` most recent UTC days that have a backup,
//   - the newest backup of each of the `weekly` most recent weeks (Monday to Sunday, UTC) that have one.
// Days and weeks are counted among those that have a backup, so a long pause (the app was down) does
// not delete the history. Names that do not match the backup pattern are not backups: they appear in
// neither list.
import { parseBackupFileName } from "./names.ts";

export type RetentionRule = {
  /** How many days keep their newest backup. */
  daily: number;
  /** How many weeks keep their newest backup. */
  weekly: number;
  /** Backups younger than this are always kept. */
  graceMs: number;
};

export const DEFAULT_RETENTION: RetentionRule = {
  daily: 7,
  weekly: 4,
  graceMs: 24 * 60 * 60 * 1000,
};

export type RotationPlan = {
  /** Backup file names that stay, newest first. */
  keep: string[];
  /** Backup file names to delete, newest first. */
  remove: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(at: Date): number {
  return Math.floor(at.getTime() / DAY_MS);
}

// 1970-01-01 was a Thursday; shifting by 3 days makes a week start on Monday.
function weekKey(at: Date): number {
  return Math.floor((dayKey(at) + 3) / 7);
}

export function planRotation(
  names: readonly string[],
  now: Date,
  rule: RetentionRule,
): RotationPlan {
  const backups = names
    .flatMap((name) => {
      const parsed = parseBackupFileName(name);
      return parsed ? [{ name, ...parsed }] : [];
    })
    .sort(
      (a, b) =>
        b.at.getTime() - a.at.getTime() ||
        b.sequence - a.sequence ||
        (a.name < b.name ? 1 : -1),
    );

  const keep = new Set<string>();
  const newest = backups[0];
  if (newest) keep.add(newest.name);

  for (const backup of backups) {
    if (now.getTime() - backup.at.getTime() < rule.graceMs)
      keep.add(backup.name);
  }

  keepNewestPerBucket(backups, dayKey, rule.daily, keep);
  keepNewestPerBucket(backups, weekKey, rule.weekly, keep);

  return {
    keep: backups.filter((b) => keep.has(b.name)).map((b) => b.name),
    remove: backups.filter((b) => !keep.has(b.name)).map((b) => b.name),
  };
}

// `backups` is sorted newest first, so the first backup of a bucket is its newest.
function keepNewestPerBucket(
  backups: ReadonlyArray<{ name: string; at: Date }>,
  bucketOf: (at: Date) => number,
  limit: number,
  keep: Set<string>,
): void {
  const seen = new Set<number>();
  for (const backup of backups) {
    const bucket = bucketOf(backup.at);
    if (seen.has(bucket)) continue;
    if (seen.size >= limit) return;
    seen.add(bucket);
    keep.add(backup.name);
  }
}
