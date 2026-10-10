// Pins down restoring a backup into the data directory: the backup is checked first and a bad one
// stops the restore before anything is touched; a good one replaces the database in one step, the
// old database (with its write-ahead log) is kept aside, and the app can start on the result.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startDatabase } from "../db/startup.ts";
import {
  integrityOf,
  namesIn,
  seedInstance,
  tableCounts,
} from "../test-support/backup-harness.ts";
import {
  createTestDatabase,
  createTestDirectory,
  track,
} from "../test-support/test-database.ts";
import { createBackup } from "./create-backup.ts";
import { BackupError } from "./errors.ts";
import { restoreBackup } from "./restore.ts";

const NOW = new Date("2026-10-11T08:00:00Z");

/** A real backup of a seeded instance, and the table counts it must restore to. */
async function aBackup() {
  const source = await createTestDatabase();
  await seedInstance(source.db);
  const target = join(await createTestDirectory(), "backups");
  mkdirSync(target);
  const backup = createBackup({
    databasePath: source.config.path,
    backupDir: target,
  });
  return { backup, expected: tableCounts(source.config.path), target };
}

function failureOf(run: () => unknown): BackupError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BackupError);
    return error as BackupError;
  }
  throw new Error("expected the restore to fail");
}

describe("restoring a backup", () => {
  // CR-40-T10
  it("rebuilds the database in an empty data directory so that the app starts on it with the data of the backup", async () => {
    const { backup, expected } = await aBackup();
    const dataDir = await createTestDirectory();
    const databasePath = join(dataDir, "app.db");

    const result = restoreBackup({
      backupPath: backup.path,
      databasePath,
      now: () => NOW,
    });

    expect(result.previousKeptAs).toBeNull();
    expect(integrityOf(databasePath)).toBe("ok");
    expect(tableCounts(databasePath)).toEqual(expected);
    // The way the app starts: open (WAL, foreign keys), run pending migrations (none), read.
    const { db, migrationsApplied } = await startDatabase({
      path: databasePath,
      busyTimeoutMs: 5000,
    });
    track(db);
    expect(migrationsApplied).toEqual([]);
    const users = await db.selectFrom("users").select("github_login").execute();
    expect(users.map((user) => user.github_login).sort()).toEqual([
      "ada",
      "grace",
    ]);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  // CR-40-T10
  it("replaces an existing database, keeps it aside, and drops its stale write-ahead log", async () => {
    const { backup, expected } = await aBackup();
    const current = await createTestDatabase();
    await current.db.destroy();
    writeFileSync(
      `${current.config.path}-wal`,
      "stale log of the old database",
    );
    writeFileSync(`${current.config.path}-shm`, "stale index");
    const oldBytes = readFileSync(current.config.path);

    const result = restoreBackup({
      backupPath: backup.path,
      databasePath: current.config.path,
      now: () => NOW,
    });

    expect(tableCounts(current.config.path)).toEqual(expected);
    expect(existsSync(`${current.config.path}-wal`)).toBe(false);
    expect(existsSync(`${current.config.path}-shm`)).toBe(false);
    expect(result.previousKeptAs).toBe(
      `${current.config.path}.before-restore-20261011T080000Z`,
    );
    expect(readFileSync(result.previousKeptAs ?? "").equals(oldBytes)).toBe(
      true,
    );
    expect(namesIn(current.directory)).toEqual([
      "app.db",
      "app.db-shm.before-restore-20261011T080000Z",
      "app.db-wal.before-restore-20261011T080000Z",
      "app.db.before-restore-20261011T080000Z",
    ]);
  });

  // CR-40-T11
  it("stops with a clear message and changes nothing when the backup is truncated", async () => {
    const { backup } = await aBackup();
    truncateSync(backup.path, 5000);
    const current = await createTestDatabase();
    await seedInstance(current.db);
    await current.db.destroy();
    const before = readFileSync(current.config.path);
    const filesBefore = namesIn(current.directory);

    const error = failureOf(() =>
      restoreBackup({
        backupPath: backup.path,
        databasePath: current.config.path,
      }),
    );

    expect(error.code).toBe("RESTORE_BACKUP_INVALID");
    expect(error.message).toContain("integrity check");
    expect(readFileSync(current.config.path).equals(before)).toBe(true);
    expect(namesIn(current.directory)).toEqual(filesBefore);
  });

  // CR-40-T11
  it("stops with a clear message when the file is not a database at all, and leaves the data directory untouched", async () => {
    const current = await createTestDatabase();
    await current.db.destroy();
    const junk = join(await createTestDirectory(), "junk.db");
    writeFileSync(junk, "definitely not sqlite ".repeat(300));
    const filesBefore = namesIn(current.directory);

    const error = failureOf(() =>
      restoreBackup({ backupPath: junk, databasePath: current.config.path }),
    );

    expect(error.code).toBe("RESTORE_BACKUP_INVALID");
    expect(namesIn(current.directory)).toEqual(filesBefore);
  });

  // CR-40-T11
  it("stops with a clear message when the backup file does not exist", async () => {
    const current = await createTestDatabase();
    await current.db.destroy();
    const missing = join(current.directory, "..", "missing.db");

    const error = failureOf(() =>
      restoreBackup({ backupPath: missing, databasePath: current.config.path }),
    );

    expect(error.code).toBe("RESTORE_BACKUP_MISSING");
    expect(error.message).toContain(missing);
  });

  // CR-40-T11
  it("puts the old database back when the swap fails halfway", async () => {
    const { backup } = await aBackup();
    const current = await createTestDatabase();
    await seedInstance(current.db);
    await current.db.destroy();
    const before = readFileSync(current.config.path);

    const error = failureOf(() =>
      restoreBackup({
        backupPath: backup.path,
        databasePath: current.config.path,
        hooks: {
          afterOldDatabaseMoved: () => {
            throw new Error("simulated failure");
          },
        },
      }),
    );

    expect(error.code).toBe("RESTORE_FAILED");
    expect(readFileSync(current.config.path).equals(before)).toBe(true);
    expect(namesIn(current.directory)).toEqual(["app.db"]);
  });

  it("refuses a data directory that does not exist", async () => {
    const { backup } = await aBackup();
    const missingDir = join(await createTestDirectory(), "nowhere", "app.db");

    const error = failureOf(() =>
      restoreBackup({ backupPath: backup.path, databasePath: missingDir }),
    );

    expect(error.code).toBe("RESTORE_FAILED");
  });
});
