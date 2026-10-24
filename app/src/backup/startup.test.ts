// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the start of the backup scheduler: only in production, with a clear line for what is
// scheduled, a loud one when the target does not work, and a stop on an invalid setting.
import { describe, expect, it, vi } from "vitest";
import {
  checkBackupConfigOnStart,
  startBackupSchedulerOnStart,
} from "./startup.ts";

function recorder() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (m: string) => lines.push(`info ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
      error: (m: string) => lines.push(`error ${m}`),
    },
  };
}

const PRODUCTION = { NODE_ENV: "production", BACKUP_DIR: "/no/such/volume" };

describe("starting the backup scheduler", () => {
  // CR-40-T14
  it("starts nothing outside production", () => {
    const startScheduler = vi.fn();

    const result = startBackupSchedulerOnStart({
      env: { NODE_ENV: "development" },
      startScheduler,
      log: recorder().log,
    });

    expect(result).toBeNull();
    expect(startScheduler).not.toHaveBeenCalled();
  });

  // CR-40-T16
  it("starts the timer with the configured time and says so", () => {
    const stop = vi.fn();
    const startScheduler = vi.fn(() => ({ stop }));
    const { lines, log } = recorder();

    const result = startBackupSchedulerOnStart({
      env: { ...PRODUCTION, BACKUP_TIME: "04:05" },
      startScheduler,
      log,
    });

    expect(result).toEqual({ stop });
    expect(startScheduler).toHaveBeenCalledWith(
      expect.objectContaining({ time: { hour: 4, minute: 5 } }),
    );
    expect(lines.at(-1)).toBe(
      "info [backup] daily backup scheduled at 04:05 UTC into /no/such/volume",
    );
  });

  // CR-40-T16
  it("warns loudly that the target cannot be used, and still starts the timer", () => {
    const startScheduler = vi.fn(() => ({ stop: () => undefined }));
    const { lines, log } = recorder();

    startBackupSchedulerOnStart({ env: PRODUCTION, startScheduler, log });

    expect(lines[0]).toContain("error [backup] BACKUP_TARGET_UNAVAILABLE");
    expect(lines[0]).toContain("/no/such/volume");
    expect(startScheduler).toHaveBeenCalledTimes(1);
  });

  // CR-40-T16
  it("warns that nothing is scheduled when BACKUP_TIME is off", () => {
    const startScheduler = vi.fn();
    const { lines, log } = recorder();

    const result = startBackupSchedulerOnStart({
      env: { ...PRODUCTION, BACKUP_TIME: "off" },
      startScheduler,
      log,
    });

    expect(result).toBeNull();
    expect(lines).toEqual([
      expect.stringContaining("warn [backup] BACKUP_TIME=off"),
    ]);
    expect(startScheduler).not.toHaveBeenCalled();
  });

  // CR-40-T16
  it("ends the start with one readable line when BACKUP_TIME is invalid", () => {
    const exit = vi.fn();
    const startScheduler = vi.fn();
    const { lines, log } = recorder();

    startBackupSchedulerOnStart({
      env: { ...PRODUCTION, BACKUP_TIME: "teatime" },
      startScheduler,
      log,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toEqual([
      expect.stringContaining("error [backup] BACKUP_CONFIG_INVALID"),
    ]);
    expect(startScheduler).not.toHaveBeenCalled();
  });

  // #105-PG-13
  it("starts no scheduler with Postgres and says in one line that backups are the operator's job", () => {
    const startScheduler = vi.fn();
    const { lines, log } = recorder();

    const result = startBackupSchedulerOnStart({
      env: {
        ...PRODUCTION,
        DATABASE_URL: "postgres://u:p@db:5432/app",
        BACKUP_TIME: "teatime",
      },
      startScheduler,
      log,
    });

    expect(result).toBeNull();
    expect(startScheduler).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("operator");
    expect(lines[0]).toContain("Postgres");
  });
});

describe("checking the backup settings at the start of the server", () => {
  // CR-76-T03
  it("ends the start naming BACKUP_TIME and the expected format when it is invalid", () => {
    const exit = vi.fn();
    const { lines, log } = recorder();

    checkBackupConfigOnStart({
      env: { ...PRODUCTION, BACKUP_TIME: "25:99" },
      log,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("error [backup] BACKUP_CONFIG_INVALID");
    expect(lines[0]).toContain("BACKUP_TIME");
    expect(lines[0]).toContain("HH:MM");
  });

  // CR-76-T03
  it.each(["02:30", "off", ""])(
    "lets the start go on with BACKUP_TIME %j",
    (time) => {
      const exit = vi.fn();
      const { lines, log } = recorder();

      checkBackupConfigOnStart({
        env: { ...PRODUCTION, BACKUP_TIME: time },
        log,
        exit,
      });

      expect(exit).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
    },
  );

  // CR-76-T03
  it("checks nothing outside production", () => {
    const exit = vi.fn();

    checkBackupConfigOnStart({
      env: { NODE_ENV: "development", BACKUP_TIME: "teatime" },
      log: recorder().log,
      exit,
    });

    expect(exit).not.toHaveBeenCalled();
  });
});
