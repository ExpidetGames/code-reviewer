// SPDX-License-Identifier: LicenseRef-Proprietary

// How long a run took, from its times. Pure: the current time is passed in, so a running run's
// duration is a function of the clock the caller hands over (the server's time of answering, which is
// what the page shows until the next answer).
import type { JobStatus } from "../db/job-status.ts";

/**
 * Milliseconds the run has been going or took:
 * - waiting: null (it has not started);
 * - running: from its start to `now`;
 * - finished (and a cancelled or replaced run that never started): null when it never started,
 *   otherwise from its start to its end.
 * A time that cannot be read, or an end before the start, gives null rather than a wrong number.
 */
export function runDurationMs(
  run: {
    status: JobStatus;
    startedAt: string | null;
    finishedAt: string | null;
  },
  now: Date,
): number | null {
  if (run.status === "queued" || run.startedAt === null) return null;
  const start = Date.parse(run.startedAt);
  if (Number.isNaN(start)) return null;
  if (run.status === "running") {
    return Math.max(0, now.getTime() - start);
  }
  if (run.finishedAt === null) return null;
  const end = Date.parse(run.finishedAt);
  if (Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** "45 s", "3 min 05 s", "1 h 02 min": short, whole seconds, never more than two parts. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  if (minutes > 0)
    return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
  return `${seconds} s`;
}
