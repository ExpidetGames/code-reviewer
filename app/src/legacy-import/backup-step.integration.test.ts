// SPDX-License-Identifier: Apache-2.0

// The backup that comes before the update (docs/decisions/0001-editions-setup-and-accounts.md, section 2.11,
// point 1): an installation of the release before accounts is backed up before the migrations touch it, the
// backup restores to exactly what the previous release left, a failing backup ends the start without a single
// change to the database, and installations that need no import need no backup.
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { restoreBackup } from "../backup/restore.ts";
import { openDatabase } from "../db/connection.ts";
import { migrateToLatest } from "../db/migrate.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createLegacyInstallation } from "../test-support/legacy-installation.ts";
import { createTestDirectory, track } from "../test-support/test-database.ts";
import {
  backupBeforeUpdateOnStart,
  holdsInstallationToImport,
} from "./backup-step.ts";

const SECRET = "legacy-secret-0123456789-0123456789-abcdef";

async function legacyFile() {
  const directory = await createTestDirectory();
  const databasePath = join(directory, "data", "app.db");
  mkdirSync(join(directory, "data"));
  const backupDir = join(directory, "backups");
  mkdirSync(backupDir);
  await createLegacyInstallation(databasePath, {
    secret: SECRET,
    users: [
      { login: "alice", githubId: 1001 },
      { login: "bob", githubId: 1002 },
    ],
    installations: [
      {
        id: 5001,
        accountLogin: "acme",
        accountId: 77,
        repositories: [{ id: 9001, fullName: "acme/widgets", project: true }],
      },
    ],
  });
  return { directory, databasePath, backupDir };
}

function countOf(path: string, table: string): number {
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    return (
      db.prepare(`select count(*) as n from ${table}`).get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

function tablesOf(path: string): string[] {
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    return (
      db
        .prepare("select name from sqlite_master where type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

function startOptions(files: { databasePath: string; backupDir: string }) {
  const lines: string[] = [];
  const exits: number[] = [];
  return {
    lines,
    exits,
    options: {
      env: { DATABASE_PATH: files.databasePath, BACKUP_DIR: files.backupDir },
      log: {
        info: (line: string) => void lines.push(line),
        error: (line: string) => void lines.push(line),
      },
      exit: (code: number) => void exits.push(code),
    },
  };
}

describe("the backup before the update", () => {
  // #106-IM-17
  it("backs up a database of the previous release before it is migrated, and the backup restores to exactly that", async () => {
    const files = await legacyFile();
    const { options, lines, exits } = startOptions(files);

    const taken = backupBeforeUpdateOnStart(options);

    expect(taken).toBe(true);
    expect(exits).toEqual([]);
    const backups = readdirSync(files.backupDir);
    expect(backups).toHaveLength(1);
    expect(lines.join("\n")).toContain("BACKUP_BEFORE_UPDATE");
    // Then the update runs (the migrations) and the file moves on.
    const db = track(
      openDatabase({ path: files.databasePath, busyTimeoutMs: 5000 }),
    );
    await migrateToLatest(db);
    await createInstanceSettingsRepository(db).set(
      "import_state",
      "done",
      null,
    );
    expect(tablesOf(files.databasePath)).toContain("workspaces");
    // The backup is the database as the previous release left it: no workspaces, the same rows.
    const backupPath = join(files.backupDir, backups[0] ?? "");
    expect(tablesOf(backupPath)).not.toContain("workspaces");
    expect(tablesOf(backupPath)).not.toContain("instance_settings");
    expect(countOf(backupPath, "users")).toBe(2);
    expect(countOf(backupPath, "jobs")).toBe(2);
    expect(countOf(backupPath, "app_settings")).toBe(1);
    // Restored, the previous release can run on it again.
    await db.destroy();
    restoreBackup({ backupPath, databasePath: files.databasePath });
    expect(tablesOf(files.databasePath)).not.toContain("workspaces");
    expect(countOf(files.databasePath, "users")).toBe(2);
  });

  // #106-IM-17
  it("does not start the update when the backup fails, and says why without touching the database", async () => {
    const files = await legacyFile();
    const { options, lines, exits } = startOptions({
      databasePath: files.databasePath,
      backupDir: join(files.directory, "no-such-volume"),
    });
    const before = tablesOf(files.databasePath);

    const taken = backupBeforeUpdateOnStart(options);

    expect(taken).toBe(false);
    expect(exits).toEqual([1]);
    const log = lines.join("\n");
    expect(log).toContain("BACKUP_TARGET_UNAVAILABLE");
    expect(log).toContain("UPDATE_BACKUP_FAILED");
    expect(log).toContain("the database was not changed");
    expect(tablesOf(files.databasePath)).toEqual(before);
  });

  // #106-IM-17
  it("refuses a backup directory inside the data directory", async () => {
    const files = await legacyFile();
    const { options, exits } = startOptions({
      databasePath: files.databasePath,
      backupDir: join(files.directory, "data"),
    });

    backupBeforeUpdateOnStart(options);

    expect(exits).toEqual([1]);
  });

  // #106-IM-22
  it("takes another backup when the import has to run again, which is harmless", async () => {
    const files = await legacyFile();
    const { options } = startOptions(files);

    backupBeforeUpdateOnStart(options);
    backupBeforeUpdateOnStart(options);

    expect(readdirSync(files.backupDir)).toHaveLength(2);
  });

  // #106-IM-16
  it("takes no backup for a database without users, a missing file, an imported installation or a set up one", async () => {
    const files = await legacyFile();
    const { options } = startOptions(files);
    const empty = await createTestDirectory();
    const emptyPath = join(empty, "app.db");
    await createLegacyInstallation(emptyPath, {
      secret: SECRET,
      users: [],
      reviewDefaults: null,
    });
    expect(holdsInstallationToImport(emptyPath)).toBe(false);
    expect(holdsInstallationToImport(join(empty, "missing.db"))).toBe(false);

    // Imported already: the marker is `done`.
    const db = track(
      openDatabase({ path: files.databasePath, busyTimeoutMs: 5000 }),
    );
    await migrateToLatest(db);
    expect(holdsInstallationToImport(files.databasePath)).toBe(true);
    await createInstanceSettingsRepository(db).set(
      "import_state",
      "done",
      null,
    );
    expect(holdsInstallationToImport(files.databasePath)).toBe(false);
    // Set up: the wizard has finished.
    await createInstanceSettingsRepository(db).set(
      "import_state",
      "none",
      null,
    );
    await createInstanceSettingsRepository(db).set(
      "setup_completed_at",
      "2026-10-12T10:00:00.000Z",
      null,
    );
    expect(holdsInstallationToImport(files.databasePath)).toBe(false);
    expect(backupBeforeUpdateOnStart(options)).toBe(false);
    expect(readdirSync(files.backupDir)).toEqual([]);
  });

  // #106-IM-17
  it("writes nothing but file names and error codes to the log", async () => {
    const files = await legacyFile();
    const { options, lines } = startOptions(files);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    backupBeforeUpdateOnStart({ ...options });

    const log = lines.join("\n");
    expect(log).not.toContain("alice");
    expect(log).not.toContain(SECRET);
    info.mockRestore();
  });
});
