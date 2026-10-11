// Pins down the backup settings: where the backups go (BACKUP_DIR, default /backups), when the
// scheduler runs (BACKUP_TIME, UTC, default 02:30, "off" switches it off), and that a typo is an
// error and not a silently missing backup.
import { describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_PATH } from "../db/config.ts";
import {
  DEFAULT_BACKUP_DIR,
  DEFAULT_BACKUP_TIME,
  DEFAULT_DATABASE_PATH_FOR_BACKUP,
  loadBackupConfig,
  loadBackupPaths,
} from "./config.ts";

describe("backup configuration", () => {
  // CR-40-T14
  it("backs up /data/app.db to /backups at 02:30 UTC when nothing is set", () => {
    expect(loadBackupConfig({})).toEqual({
      databasePath: "/data/app.db",
      backupDir: "/backups",
      time: { hour: 2, minute: 30 },
    });
    expect(DEFAULT_BACKUP_DIR).toBe("/backups");
    expect(DEFAULT_BACKUP_TIME).toBe("02:30");
  });

  it("uses the same default database path as the database layer", () => {
    expect(DEFAULT_DATABASE_PATH_FOR_BACKUP).toBe(DEFAULT_DATABASE_PATH);
  });

  it("reads the paths and the time from the environment", () => {
    expect(
      loadBackupConfig({
        DATABASE_PATH: " /srv/db/app.db ",
        BACKUP_DIR: "/mnt/backups",
        BACKUP_TIME: "23:05",
      }),
    ).toEqual({
      databasePath: "/srv/db/app.db",
      backupDir: "/mnt/backups",
      time: { hour: 23, minute: 5 },
    });
  });

  it("treats blank values as unset", () => {
    expect(
      loadBackupConfig({
        BACKUP_DIR: "  ",
        BACKUP_TIME: "",
        DATABASE_PATH: "",
      }),
    ).toEqual(loadBackupConfig({}));
  });

  it("switches the scheduler off with BACKUP_TIME=off", () => {
    expect(loadBackupConfig({ BACKUP_TIME: "off" }).time).toBeNull();
    expect(loadBackupConfig({ BACKUP_TIME: "OFF" }).time).toBeNull();
  });

  // CR-40-T14
  it("rejects a time that is not HH:MM in 24 hours, without echoing the value", () => {
    for (const value of ["2.30", "24:00", "02:61", "0230", "noon", "14h"]) {
      expect(
        () => loadBackupConfig({ BACKUP_TIME: value }),
        value,
      ).toThrowError(
        expect.objectContaining({
          code: "BACKUP_CONFIG_INVALID",
          message: expect.not.stringContaining(value),
        }),
      );
    }
  });

  it("reads the paths without looking at the schedule, so a bad time cannot stop a restore", () => {
    expect(
      loadBackupPaths({
        DATABASE_PATH: "/srv/db/app.db",
        BACKUP_DIR: "/mnt/backups",
        BACKUP_TIME: "teatime",
      }),
    ).toEqual({ databasePath: "/srv/db/app.db", backupDir: "/mnt/backups" });
  });
});
