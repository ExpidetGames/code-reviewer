// SPDX-License-Identifier: Apache-2.0

// The daily timer inside the app. At the configured time of day (UTC) it runs the backup job, notes
// how it went (for the status route) and arms the next day. A failing run never stops the schedule.
//
// It is a plain timer, not a job queue: the job is a few milliseconds of work for the size of this
// database, and a missed run (the app was down at that time) is not caught up; the status shows when
// the newest backup is too old, and the same command can be run by hand or by a Coolify scheduled task.
import "server-only";
import { BackupError } from "./errors.ts";
import type { BackupJobOutcome } from "./run-backup.ts";
import type { BackupRunRecord } from "./run-state.ts";

type TimeOfDay = { hour: number; minute: number };

/** The next moment after `after` that falls on `time` o'clock UTC (never `after` itself). */
export function nextRunAfter(after: Date, time: TimeOfDay): Date {
  const candidate = new Date(
    Date.UTC(
      after.getUTCFullYear(),
      after.getUTCMonth(),
      after.getUTCDate(),
      time.hour,
      time.minute,
    ),
  );
  if (candidate.getTime() > after.getTime()) return candidate;
  return new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
}

export type BackupScheduler = { stop: () => void };

export function startBackupScheduler({
  time,
  run,
  record,
  now = () => new Date(),
  setTimer = defaultSetTimer,
}: {
  time: TimeOfDay;
  run: () => BackupJobOutcome;
  record: (entry: BackupRunRecord) => void;
  now?: () => Date;
  /** Calls `callback` after `delayMs` and returns a function that cancels it. */
  setTimer?: (callback: () => void, delayMs: number) => () => void;
}): BackupScheduler {
  let cancel: (() => void) | undefined;
  let stopped = false;

  const arm = (from: Date): void => {
    const next = nextRunAfter(from, time);
    cancel = setTimer(() => fire(next), next.getTime() - from.getTime());
  };

  const fire = (scheduledFor: Date): void => {
    const startedAt = now();
    record(describeOutcome(startedAt, now, run));
    if (stopped) return;
    // A timer can fire a few milliseconds early; arming from the later of the two keeps a run from
    // being scheduled for the same moment again.
    arm(new Date(Math.max(now().getTime(), scheduledFor.getTime())));
  };

  arm(now());
  return {
    stop: () => {
      stopped = true;
      cancel?.();
    },
  };
}

function describeOutcome(
  startedAt: Date,
  now: () => Date,
  run: () => BackupJobOutcome,
): BackupRunRecord {
  let outcome: BackupJobOutcome;
  try {
    outcome = run();
  } catch (error) {
    // The job reports its own failures as values; a throw is a bug, and still must not end the schedule.
    outcome = {
      ok: false,
      error: new BackupError(
        "BACKUP_WRITE_FAILED",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      ),
    };
    console.error(`[backup] ${outcome.error.code}: ${outcome.error.message}`);
  }
  const finishedAt = now();
  if (outcome.ok)
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ok: true,
      errorCode: null,
      rotationIncomplete: outcome.rotationProblem !== null,
      fileName: outcome.backup.fileName,
      bytes: outcome.backup.bytes,
    };
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ok: false,
    errorCode: outcome.error.code,
    rotationIncomplete: false,
    fileName: null,
    bytes: null,
  };
}

function defaultSetTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  // The timer alone must not keep the process alive.
  timer.unref();
  return () => clearTimeout(timer);
}
