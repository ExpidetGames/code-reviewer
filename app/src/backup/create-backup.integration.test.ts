// Pins down what one backup run produces from a real SQLite file in WAL mode: a single, consistent,
// verified file under a UTC time stamp in the target directory, published atomically and readable
// by its owner only; and what it does when the source or the target is unusable (a clear error code,
// no half file, nothing existing touched).
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  createTestDirectory,
} from "../test-support/test-database.ts";
import {
  holdDatabaseExclusively,
  integrityOf,
  namesIn,
  seedInstance,
  startBackgroundWriter,
  tableCounts,
  writerKeys,
} from "../test-support/backup-harness.ts";
import { createBackup } from "./create-backup.ts";
import { BackupError } from "./errors.ts";
import { parseBackupFileName } from "./names.ts";

const AT = new Date("2026-10-10T02:30:05.250Z");

async function setup() {
  const database = await createTestDatabase();
  await seedInstance(database.db);
  const target = join(await createTestDirectory(), "backups");
  mkdirSync(target);
  return { ...database, target };
}

describe("creating a backup", () => {
  // CR-40-T01
  it("writes a verified copy with a UTC time stamp in its name and the same rows in every table", async () => {
    const { config, target } = await setup();

    const result = createBackup({
      databasePath: config.path,
      backupDir: target,
      now: () => AT,
    });

    expect(result.fileName).toBe("code-reviewer-20261010T023005Z.db");
    expect(parseBackupFileName(result.fileName)?.at).toEqual(
      new Date("2026-10-10T02:30:05Z"),
    );
    expect(namesIn(target)).toEqual([result.fileName]);
    expect(result.path).toBe(join(target, result.fileName));
    expect(result.bytes).toBe(statSync(result.path).size);
    expect(integrityOf(result.path)).toBe("ok");
    const original = tableCounts(config.path);
    expect(original.users).toBe(2);
    expect(original.projects).toBe(1);
    expect(tableCounts(result.path)).toEqual(original);
  });

  // CR-40-T02
  it("includes writes that are still in the write-ahead log and not yet in the main file", async () => {
    const { config, target } = await setup();
    // The app's connection stays open, so the rows live in the -wal file. Copying the main file alone
    // would lose them: the precondition below proves the test can tell the difference.
    expect(statSync(`${config.path}-wal`).size).toBeGreaterThan(0);
    const plainCopy = join(target, "..", "plain-copy.db");
    copyFileSync(config.path, plainCopy);
    expect(tableCounts(plainCopy).users).toBe(0);

    const result = createBackup({ databasePath: config.path, backupDir: target });

    expect(tableCounts(result.path).users).toBe(2);
    expect(tableCounts(result.path).sessions).toBe(1);
  });

  // CR-40-T03
  it("produces a sound snapshot without half transactions while another process keeps writing", async () => {
    const { config, target } = await setup();
    const writer = await startBackgroundWriter(config.path);

    const results = [];
    for (let run = 0; run < 5; run += 1) {
      await writer.committed(run * 20 + 5);
      results.push(
        createBackup({
          databasePath: config.path,
          backupDir: target,
          now: () => new Date(AT.getTime() + run * 1000),
        }),
      );
    }
    writer.stop();

    for (const result of results) {
      expect(integrityOf(result.path)).toBe("ok");
      const keys = writerKeys(result.path);
      expect(keys.onlyMeta).toBe(0);
      expect(keys.onlySettings).toBe(0);
      expect(keys.both).toBeGreaterThan(0);
    }
  });

  // CR-40-T04
  it("leaves the data directory alone and publishes the file only after it is fully written", async () => {
    const { config, directory, target } = await setup();
    const dataBefore = namesIn(directory);
    const seenWhileWriting: string[][] = [];
    let integrityWhileWriting = "";

    const result = createBackup({
      databasePath: config.path,
      backupDir: target,
      now: () => AT,
      hooks: {
        beforePublish: (temporaryPath) => {
          seenWhileWriting.push(namesIn(target));
          integrityWhileWriting = integrityOf(temporaryPath);
        },
      },
    });

    expect(namesIn(directory)).toEqual(dataBefore);
    expect(existsSync(join(directory, result.fileName))).toBe(false);
    expect(seenWhileWriting).toHaveLength(1);
    const during = seenWhileWriting[0] ?? [];
    expect(during).toHaveLength(1);
    expect(parseBackupFileName(during[0] ?? "")).toBeNull();
    expect(during[0]?.startsWith(".")).toBe(true);
    expect(integrityWhileWriting).toBe("ok");
    expect(namesIn(target)).toEqual([result.fileName]);
  });

  // CR-40-T04
  it("refuses a target inside the directory of the database, which is no backup at all", async () => {
    const { config, directory } = await setup();
    const inside = join(directory, "backups");
    mkdirSync(inside);

    for (const backupDir of [directory, inside]) {
      expect(() =>
        createBackup({ databasePath: config.path, backupDir }),
      ).toThrowError(
        expect.objectContaining({ code: "BACKUP_TARGET_INSIDE_DATA" }),
      );
    }
    expect(namesIn(inside)).toEqual([]);
  });

  // CR-40-T09
  it("never overwrites an earlier backup taken in the same second and uses a different name", async () => {
    const { config, target } = await setup();
    const first = createBackup({
      databasePath: config.path,
      backupDir: target,
      now: () => AT,
    });
    const firstBytes = readFileSync(first.path);

    const second = createBackup({
      databasePath: config.path,
      backupDir: target,
      now: () => AT,
    });

    expect(second.fileName).toBe("code-reviewer-20261010T023005Z-2.db");
    expect(namesIn(target)).toEqual([first.fileName, second.fileName].sort());
    expect(readFileSync(first.path).equals(firstBytes)).toBe(true);
    expect(integrityOf(second.path)).toBe("ok");
  });

  // CR-40-T12
  it("makes the backup readable by its owner only", async () => {
    const { config, target } = await setup();

    const result = createBackup({ databasePath: config.path, backupDir: target });

    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });
});

describe("a backup that cannot be made", () => {
  async function expectFailure(
    run: () => unknown,
    code: string,
  ): Promise<BackupError> {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(BackupError);
      expect((error as BackupError).code).toBe(code);
      return error as BackupError;
    }
    throw new Error(`expected a ${code} failure`);
  }

  // CR-40-T07
  it("fails clearly when the target directory does not exist", async () => {
    const { config, target } = await setup();
    const missing = join(target, "not-there");

    const error = await expectFailure(
      () => createBackup({ databasePath: config.path, backupDir: missing }),
      "BACKUP_TARGET_UNAVAILABLE",
    );

    expect(error.message).toContain(missing);
    expect(existsSync(missing)).toBe(false);
  });

  // CR-40-T07
  it("fails clearly when the target is a file, not a directory", async () => {
    const { config, target } = await setup();
    const file = join(target, "a-file");
    writeFileSync(file, "x");

    await expectFailure(
      () => createBackup({ databasePath: config.path, backupDir: file }),
      "BACKUP_TARGET_UNAVAILABLE",
    );
  });

  // CR-40-T07
  it("fails clearly when the target is not writable and leaves the existing backups untouched", async () => {
    const { config, target } = await setup();
    const earlier = createBackup({
      databasePath: config.path,
      backupDir: target,
      now: () => AT,
    });
    const earlierBytes = readFileSync(earlier.path);
    chmodSync(target, 0o500);

    try {
      await expectFailure(
        () =>
          createBackup({
            databasePath: config.path,
            backupDir: target,
            now: () => new Date(AT.getTime() + 60_000),
          }),
        "BACKUP_TARGET_UNAVAILABLE",
      );
    } finally {
      chmodSync(target, 0o700);
    }

    expect(namesIn(target)).toEqual([earlier.fileName]);
    expect(readFileSync(earlier.path).equals(earlierBytes)).toBe(true);
  });

  // CR-40-T07
  it("leaves no half file behind when writing fails midway, for example on a full disk", async () => {
    const { config, target } = await setup();

    await expectFailure(
      () =>
        createBackup({
          databasePath: config.path,
          backupDir: target,
          hooks: {
            afterWrite: () => {
              throw Object.assign(new Error("no space left on device"), {
                code: "ENOSPC",
              });
            },
          },
        }),
      "BACKUP_WRITE_FAILED",
    );

    expect(namesIn(target)).toEqual([]);
  });

  // CR-40-T07
  it("discards a backup that fails the integrity check instead of publishing it", async () => {
    const { config, target } = await setup();

    await expectFailure(
      () =>
        createBackup({
          databasePath: config.path,
          backupDir: target,
          hooks: { afterWrite: (path) => truncateSync(path, 5000) },
        }),
      "BACKUP_VERIFY_FAILED",
    );

    expect(namesIn(target)).toEqual([]);
  });

  // CR-40-T08
  it("fails clearly when the source database does not exist and creates nothing", async () => {
    const { directory, target } = await setup();
    const missing = join(directory, "gone.db");

    const error = await expectFailure(
      () => createBackup({ databasePath: missing, backupDir: target }),
      "BACKUP_SOURCE_MISSING",
    );

    expect(error.message).toContain(missing);
    expect(existsSync(missing)).toBe(false);
    expect(namesIn(target)).toEqual([]);
  });

  // CR-40-T08
  it("fails clearly when the source is not a SQLite database and creates nothing", async () => {
    const { directory, target } = await setup();
    const junk = join(directory, "junk.db");
    writeFileSync(junk, "this is not a database. ".repeat(200));

    await expectFailure(
      () => createBackup({ databasePath: junk, backupDir: target }),
      "BACKUP_SOURCE_INVALID",
    );

    expect(namesIn(target)).toEqual([]);
  });

  // CR-40-T08
  it("fails with a lock error after the busy timeout when another process holds the database, and creates nothing", async () => {
    const { db, config, target } = await setup();
    await db.destroy();
    await holdDatabaseExclusively(config.path);
    const started = Date.now();

    await expectFailure(
      () =>
        createBackup({
          databasePath: config.path,
          backupDir: target,
          busyTimeoutMs: 300,
        }),
      "BACKUP_SOURCE_LOCKED",
    );

    expect(Date.now() - started).toBeLessThan(5000);
    expect(namesIn(target)).toEqual([]);
  });
});
