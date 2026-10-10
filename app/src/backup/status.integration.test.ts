// Pins down what the status route tells the people who run the instance: whether backups are
// scheduled, whether the target works right now, how the last scheduled run went, and which backup
// is the newest. It reads the real directory, so the picture is true after an app restart too.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "../test-support/test-database.ts";
import { createBackup } from "./create-backup.ts";
import { loadBackupConfig } from "./config.ts";
import { readBackupStatus } from "./status.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const NOW = new Date("2026-10-10T12:00:00Z");

async function setup(env: Record<string, string> = {}) {
  const database = await createTestDatabase();
  const backupDir = join(await createTestDirectory(), "backups");
  mkdirSync(backupDir);
  const config = loadBackupConfig({
    DATABASE_PATH: database.config.path,
    BACKUP_DIR: backupDir,
    ...env,
  });
  return { config, backupDir };
}

describe("the backup status", () => {
  it("reports the newest backup, the number of backups and a healthy target", async () => {
    const { config, backupDir } = await setup();
    createBackup({
      databasePath: config.databasePath,
      backupDir,
      now: () => new Date("2026-10-09T02:30:00Z"),
    });
    const newest = createBackup({
      databasePath: config.databasePath,
      backupDir,
      now: () => new Date("2026-10-10T02:30:00Z"),
    });
    writeFileSync(join(backupDir, "notes.txt"), "not a backup");

    const status = readBackupStatus({ config, lastRun: null, now: NOW });

    expect(status.schedule).toEqual({ enabled: true, timeUtc: "02:30" });
    expect(status.target).toEqual({ usable: true, errorCode: null });
    expect(status.backupCount).toBe(2);
    expect(status.newestBackup).toEqual({
      fileName: newest.fileName,
      createdAt: "2026-10-10T02:30:00.000Z",
      bytes: newest.bytes,
    });
    expect(status.stale).toBe(false);
  });

  it("flags a missing target with its error code and no backups", async () => {
    const { config, backupDir } = await setup();

    const status = readBackupStatus({
      config: { ...config, backupDir: join(backupDir, "gone") },
      lastRun: null,
      now: NOW,
    });

    expect(status.target).toEqual({
      usable: false,
      errorCode: "BACKUP_TARGET_UNAVAILABLE",
    });
    expect(status.newestBackup).toBeNull();
    expect(status.backupCount).toBe(0);
    expect(status.stale).toBe(true);
  });

  it("calls the backups stale when the newest is older than a day and a half", async () => {
    const { config, backupDir } = await setup();
    createBackup({
      databasePath: config.databasePath,
      backupDir,
      now: () => new Date("2026-10-08T11:00:00Z"),
    });

    expect(readBackupStatus({ config, lastRun: null, now: NOW }).stale).toBe(
      true,
    );
  });

  it("never calls the backups stale while the scheduler is switched off", async () => {
    const { config } = await setup({ BACKUP_TIME: "off" });

    const status = readBackupStatus({ config, lastRun: null, now: NOW });

    expect(status.schedule).toEqual({ enabled: false, timeUtc: null });
    expect(status.stale).toBe(false);
  });

  it("passes the last scheduled run through and shows no directory path", async () => {
    const { config, backupDir } = await setup();
    const lastRun = {
      startedAt: "2026-10-10T02:30:00.000Z",
      finishedAt: "2026-10-10T02:30:01.000Z",
      ok: false,
      errorCode: "BACKUP_TARGET_UNAVAILABLE" as const,
      message: "The backup target does not exist.",
      fileName: null,
      bytes: null,
    };

    const status = readBackupStatus({ config, lastRun, now: NOW });

    expect(status.lastRun).toEqual(lastRun);
    expect(JSON.stringify({ ...status, lastRun: null })).not.toContain(
      backupDir,
    );
  });
});
