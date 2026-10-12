// SPDX-License-Identifier: Apache-2.0

// Pins down the whole job (a backup, then the rotation): old backups beyond the retention go, files
// that are not backups stay, a failed backup deletes nothing, and the log says where the file is and
// how big it is, never what is in it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  createTestDirectory,
} from "../test-support/test-database.ts";
import { namesIn, seedInstance } from "../test-support/backup-harness.ts";
import { backupFileName } from "./names.ts";
import { runBackupJob } from "./run-backup.ts";

const NOW = new Date("2026-10-31T02:30:00Z");

async function setup() {
  const database = await createTestDatabase();
  await seedInstance(database.db);
  const target = join(await createTestDirectory(), "backups");
  mkdirSync(target);
  return { ...database, target };
}

function logger() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
    },
  };
}

/** An old "backup" file: only its name matters to the rotation. */
function plant(target: string, iso: string): string {
  const name = backupFileName(new Date(iso), 1);
  writeFileSync(join(target, name), "old");
  return name;
}

describe("the backup job", () => {
  // CR-40-T05
  it("deletes backups beyond the retention after a successful backup and leaves other files alone", async () => {
    const { config, target } = await setup();
    // 40 consecutive days: well beyond 7 daily and 4 weekly backups.
    const planted = Array.from({ length: 40 }, (_, index) =>
      plant(
        target,
        new Date(NOW.getTime() - (index + 1) * 86_400_000).toISOString(),
      ),
    );
    writeFileSync(join(target, "notes.txt"), "keep me");
    writeFileSync(join(target, "app.db"), "not a backup name");

    const outcome = runBackupJob({
      databasePath: config.path,
      backupDir: target,
      now: () => NOW,
      log: logger().log,
    });

    expect(outcome.ok).toBe(true);
    const left = namesIn(target);
    expect(left).toContain("notes.txt");
    expect(left).toContain("app.db");
    expect(left).toContain("code-reviewer-20261031T023000Z.db");
    expect(left.length).toBeLessThan(planted.length / 2);
    expect(left).toContain(planted[0]);
    expect(left).not.toContain(planted[30]);
    const backupsLeft = left.filter((name) =>
      name.startsWith("code-reviewer-"),
    );
    // Every planted backup plus the new one either stayed or was reported as removed.
    if (outcome.ok)
      expect(outcome.removed.length + backupsLeft.length).toBe(
        planted.length + 1,
      );
  });

  // CR-40-T07
  it("deletes nothing when the backup fails, even though old backups are beyond the retention", async () => {
    const { directory, target } = await setup();
    const old = Array.from({ length: 30 }, (_, index) =>
      plant(
        target,
        new Date(NOW.getTime() - (index + 1) * 86_400_000).toISOString(),
      ),
    );
    const { lines, log } = logger();

    const outcome = runBackupJob({
      databasePath: join(directory, "gone.db"),
      backupDir: target,
      now: () => NOW,
      log,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("BACKUP_SOURCE_MISSING");
    expect(namesIn(target)).toEqual([...old].sort());
    expect(lines.join("\n")).toContain("BACKUP_SOURCE_MISSING");
  });

  // CR-40-T07
  it("fails with a clear message and deletes nothing when the target directory is missing", async () => {
    const { config, directory } = await setup();
    const missing = join(directory, "..", "no-such-volume");
    const { lines, log } = logger();

    const outcome = runBackupJob({
      databasePath: config.path,
      backupDir: missing,
      log,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(outcome.error.code).toBe("BACKUP_TARGET_UNAVAILABLE");
    expect(lines.join("\n")).toContain(missing);
  });

  // CR-40-T12
  it("logs the path and the size of the backup and nothing from the database", async () => {
    const { config, target } = await setup();
    const { lines, log } = logger();

    const outcome = runBackupJob({
      databasePath: config.path,
      backupDir: target,
      now: () => NOW,
      log,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(lines).toEqual([
      `[backup] created ${outcome.backup.path} (${String(outcome.backup.bytes)} bytes)`,
    ]);
    const text = lines.join("\n");
    for (const secret of [
      "dummy-session-token-for-tests",
      "example.test",
      "ada",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
