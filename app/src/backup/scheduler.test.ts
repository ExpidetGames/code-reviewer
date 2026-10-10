// Pins down the daily scheduler: when the next run falls (UTC), that a run happens when the timer
// fires, that a failed or crashing run is recorded and does not stop the schedule, and that
// stopping cancels the timer. Time and timers are injected, nothing waits.
import { describe, expect, it, vi } from "vitest";
import { BackupError } from "./errors.ts";
import type { BackupJobOutcome } from "./run-backup.ts";
import { nextRunAfter, startBackupScheduler } from "./scheduler.ts";

const TIME = { hour: 2, minute: 30 };

describe("nextRunAfter", () => {
  it("is today when the time of day is still ahead", () => {
    expect(nextRunAfter(new Date("2026-10-10T01:00:00Z"), TIME)).toEqual(
      new Date("2026-10-10T02:30:00Z"),
    );
  });

  it("is tomorrow when the time of day has passed or is right now", () => {
    expect(nextRunAfter(new Date("2026-10-10T02:30:00Z"), TIME)).toEqual(
      new Date("2026-10-11T02:30:00Z"),
    );
    expect(nextRunAfter(new Date("2026-10-10T23:59:59Z"), TIME)).toEqual(
      new Date("2026-10-11T02:30:00Z"),
    );
  });

  it("rolls over month and year ends", () => {
    expect(nextRunAfter(new Date("2026-12-31T12:00:00Z"), TIME)).toEqual(
      new Date("2027-01-01T02:30:00Z"),
    );
  });
});

function successOutcome(): BackupJobOutcome {
  return {
    ok: true,
    backup: {
      fileName: "code-reviewer-20261010T023000Z.db",
      path: "/backups/code-reviewer-20261010T023000Z.db",
      bytes: 4096,
      createdAt: new Date("2026-10-10T02:30:00Z"),
    },
    removed: [],
    rotationProblem: null,
  };
}

/** A clock and a timer the test drives by hand. */
function fakeTime(start: string) {
  let current = new Date(start);
  const timers: Array<{
    delay: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];
  return {
    now: () => current,
    setTimer: (callback: () => void, delay: number) => {
      const timer = { delay, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    /** Moves the clock to the pending timer's moment and fires it. */
    fireNext: () => {
      const timer = timers.filter((t) => !t.cancelled).at(-1);
      if (!timer) throw new Error("no timer is pending");
      current = new Date(current.getTime() + timer.delay);
      timer.cancelled = true;
      timer.callback();
    },
    timers,
  };
}

describe("the backup scheduler", () => {
  it("arms a timer for the next run time and runs the job when it fires", () => {
    const time = fakeTime("2026-10-10T01:00:00Z");
    const run = vi.fn(successOutcome);
    const recorded: unknown[] = [];

    startBackupScheduler({
      time: TIME,
      run,
      now: time.now,
      setTimer: time.setTimer,
      record: (entry) => recorded.push(entry),
    });

    expect(time.timers[0]?.delay).toBe(90 * 60 * 1000);
    expect(run).not.toHaveBeenCalled();

    time.fireNext();

    expect(run).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([
      expect.objectContaining({
        ok: true,
        fileName: "code-reviewer-20261010T023000Z.db",
        bytes: 4096,
        errorCode: null,
      }),
    ]);
  });

  it("arms the run of the next day after a run", () => {
    const time = fakeTime("2026-10-10T01:00:00Z");
    startBackupScheduler({
      time: TIME,
      run: successOutcome,
      now: time.now,
      setTimer: time.setTimer,
      record: () => undefined,
    });

    time.fireNext();

    const pending = time.timers.filter((t) => !t.cancelled);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.delay).toBe(24 * 60 * 60 * 1000);
  });

  it("records a failed run with its error code and keeps the schedule", () => {
    const time = fakeTime("2026-10-10T01:00:00Z");
    const recorded: Array<{
      ok: boolean;
      errorCode: string | null;
      message: string | null;
    }> = [];
    startBackupScheduler({
      time: TIME,
      run: () => ({
        ok: false,
        error: new BackupError(
          "BACKUP_TARGET_UNAVAILABLE",
          "the volume is missing",
        ),
      }),
      now: time.now,
      setTimer: time.setTimer,
      record: (entry) => recorded.push(entry),
    });

    time.fireNext();

    expect(recorded).toEqual([
      expect.objectContaining({
        ok: false,
        errorCode: "BACKUP_TARGET_UNAVAILABLE",
        message: "the volume is missing",
      }),
    ]);
    expect(time.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });

  it("records a crashing run as a failure without leaking the schedule", () => {
    const time = fakeTime("2026-10-10T01:00:00Z");
    const recorded: Array<{ ok: boolean; errorCode: string | null }> = [];
    startBackupScheduler({
      time: TIME,
      run: () => {
        throw new Error("unexpected");
      },
      now: time.now,
      setTimer: time.setTimer,
      record: (entry) => recorded.push(entry),
    });

    time.fireNext();

    expect(recorded).toEqual([
      expect.objectContaining({ ok: false, errorCode: "BACKUP_WRITE_FAILED" }),
    ]);
    expect(time.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });

  it("cancels the pending timer when stopped", () => {
    const time = fakeTime("2026-10-10T01:00:00Z");
    const scheduler = startBackupScheduler({
      time: TIME,
      run: successOutcome,
      now: time.now,
      setTimer: time.setTimer,
      record: () => undefined,
    });

    scheduler.stop();

    expect(time.timers.every((t) => t.cancelled)).toBe(true);
  });
});
