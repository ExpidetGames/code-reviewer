// SPDX-License-Identifier: Apache-2.0

// Pins down the command line that a Coolify scheduled task, an operator or the restore guide runs:
// `node cli.ts backup` and `node cli.ts restore <file>`. It runs as a real process (the way it runs
// in the container), so exit codes, output and files on disk are what is checked.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

function run(args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--no-warnings", cli, ...args], {
    // Only what the command needs: nothing of the test runner's environment leaks in.
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function setup() {
  const database = await createTestDatabase();
  await seedInstance(database.db);
  const target = join(await createTestDirectory(), "backups");
  mkdirSync(target);
  const env = { DATABASE_PATH: database.config.path, BACKUP_DIR: target };
  return { ...database, target, env };
}

describe("the backup command", () => {
  // CR-40-T01
  it("writes a verified backup, exits with 0 and reports the path and the size", async () => {
    const { config, target, env } = await setup();

    const result = run(["backup"], env);

    expect(result.status).toBe(0);
    const [fileName] = namesIn(target);
    expect(fileName).toMatch(/^code-reviewer-\d{8}T\d{6}Z\.db$/);
    const path = join(target, fileName ?? "");
    expect(result.stdout.trim()).toBe(
      `[backup] created ${path} (${String(statSync(path).size)} bytes)`,
    );
    expect(integrityOf(path)).toBe("ok");
    expect(tableCounts(path)).toEqual(tableCounts(config.path));
  });

  // CR-40-T12
  it("prints nothing from the database and leaves a file only the owner can read", async () => {
    const { target, env } = await setup();

    const result = run(["backup"], env);

    const output = result.stdout + result.stderr;
    for (const secret of ["dummy-session-token-for-tests", "example.test"]) {
      expect(output).not.toContain(secret);
    }
    const [fileName] = namesIn(target);
    expect(statSync(join(target, fileName ?? "")).mode & 0o777).toBe(0o600);
  });

  // CR-40-T07
  it("exits with 1 and names the problem when the target directory is missing, leaving nothing behind", async () => {
    const { env, target } = await setup();
    const missing = join(target, "no-such-volume");

    const result = run(["backup"], { ...env, BACKUP_DIR: missing });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BACKUP_TARGET_UNAVAILABLE");
    expect(result.stderr).toContain(missing);
    expect(result.stdout).toBe("");
    expect(namesIn(target)).toEqual([]);
  });

  // CR-40-T08
  it("exits with 1 and names the problem when the database does not exist, creating no file", async () => {
    const { env, target, directory } = await setup();

    const result = run(["backup"], {
      ...env,
      DATABASE_PATH: join(directory, "gone.db"),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BACKUP_SOURCE_MISSING");
    expect(namesIn(target)).toEqual([]);
  });

  // CR-40-T08
  it("does not care about an invalid BACKUP_TIME, which only the scheduler uses", async () => {
    const { env, target } = await setup();

    const result = run(["backup"], { ...env, BACKUP_TIME: "teatime" });

    expect(result.status).toBe(0);
    expect(namesIn(target)).toHaveLength(1);
  });

  // CR-40-T08
  it("really runs when started through a symlinked folder, as a scheduled task may start it", async () => {
    const { env, target } = await setup();
    const link = join(await createTestDirectory(), "linked-backup-folder");
    symlinkSync(dirname(cli), link);

    const result = spawnSync(
      process.execPath,
      ["--no-warnings", join(link, "cli.ts"), "backup"],
      {
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[backup] created");
    expect(namesIn(target)).toHaveLength(1);
  });

  it("prints the usage and exits with 2 for an unknown command", async () => {
    const { env } = await setup();

    for (const args of [[], ["frobnicate"], ["restore"], ["backup", "extra"]]) {
      const result = run(args, env);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("Usage:");
    }
  });
});

describe("the restore command", () => {
  // CR-40-T10
  it("restores a backup into an empty data directory so that the app starts with the data of the backup", async () => {
    const { config, env } = await setup();
    expect(run(["backup"], env).status).toBe(0);
    const [fileName] = namesIn(env.BACKUP_DIR);
    const dataDir = await createTestDirectory();
    const databasePath = join(dataDir, "app.db");

    const result = run(["restore", join(env.BACKUP_DIR, fileName ?? "")], {
      ...env,
      DATABASE_PATH: databasePath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`restored`);
    expect(tableCounts(databasePath)).toEqual(tableCounts(config.path));
    const { db } = await startDatabase({
      path: databasePath,
      busyTimeoutMs: 5000,
    });
    track(db);
    const users = await db.selectFrom("users").select("id").execute();
    expect(users).toHaveLength(2);
  });

  // CR-76-T01
  it("prints where leftover side files went when there is no database to move", async () => {
    const { env } = await setup();
    expect(run(["backup"], env).status).toBe(0);
    const [fileName] = namesIn(env.BACKUP_DIR);
    const databasePath = join(await createTestDirectory(), "app.db");
    writeFileSync(`${databasePath}-wal`, "log");

    const result = run(["restore", join(env.BACKUP_DIR, fileName ?? "")], {
      ...env,
      DATABASE_PATH: databasePath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no database was in place");
    expect(result.stdout).toContain(`${databasePath}-wal.before-restore-`);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
  });

  // CR-76-T01
  it("prints where the side files of the previous database went as well", async () => {
    const { env } = await setup();
    expect(run(["backup"], env).status).toBe(0);
    const [fileName] = namesIn(env.BACKUP_DIR);
    // An old database that no handle of this process holds (the CLI runs as another process).
    const databasePath = join(await createTestDirectory(), "app.db");
    copyFileSync(join(env.BACKUP_DIR, fileName ?? ""), databasePath);
    writeFileSync(`${databasePath}-shm`, "index ".repeat(50));

    const result = run(["restore", join(env.BACKUP_DIR, fileName ?? "")], {
      ...env,
      DATABASE_PATH: databasePath,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("the previous database was kept as");
    expect(result.stdout).toContain("its side files were kept as");
    expect(result.stdout).toContain(`${databasePath}-shm.before-restore-`);
  });

  // CR-40-T11
  it("exits with 1, names the failed integrity check and leaves the current database unchanged for a truncated backup", async () => {
    const { env } = await setup();
    expect(run(["backup"], env).status).toBe(0);
    const [fileName] = namesIn(env.BACKUP_DIR);
    const backupPath = join(env.BACKUP_DIR, fileName ?? "");
    truncateSync(backupPath, 4096);
    const current = await createTestDatabase();
    await current.db.destroy();
    const before = readFileSync(current.config.path);
    const filesBefore = namesIn(current.directory);

    const result = run(["restore", backupPath], {
      ...env,
      DATABASE_PATH: current.config.path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RESTORE_BACKUP_INVALID");
    expect(result.stderr).toContain("integrity check");
    expect(readFileSync(current.config.path).equals(before)).toBe(true);
    expect(namesIn(current.directory)).toEqual(filesBefore);
  });

  // CR-40-T11
  it("exits with 1 for a file that does not exist", async () => {
    const { env, directory } = await setup();

    const result = run(["restore", join(directory, "missing.db")], env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RESTORE_BACKUP_MISSING");
  });

  // CR-40-T11
  it("restores although BACKUP_TIME is invalid, because a restore is needed exactly when things are wrong", async () => {
    const { env } = await setup();
    expect(run(["backup"], env).status).toBe(0);
    const [fileName] = namesIn(env.BACKUP_DIR);
    const databasePath = join(await createTestDirectory(), "app.db");

    const result = run(["restore", join(env.BACKUP_DIR, fileName ?? "")], {
      ...env,
      DATABASE_PATH: databasePath,
      BACKUP_TIME: "teatime",
    });

    expect(result.status).toBe(0);
    expect(tableCounts(databasePath).users).toBe(2);
  });
});
