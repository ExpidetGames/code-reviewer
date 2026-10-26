// SPDX-License-Identifier: LicenseRef-Proprietary

// `pnpm migrate` against a real Postgres (#319): it applies the migrations over the direct connection
// while holding a session advisory lock, so two deployments cannot migrate at once, and a failing
// migration ends in a message and an exit code, never in `process.exit`.
import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, it, vi } from "vitest";
import { withPostgresAdvisoryLock } from "./postgres.ts";
import { MIGRATE_LOCK_KEY, runMigrateCommand } from "./migrate-cli.ts";
import { readSchemaStatus } from "./schema-status.ts";
import {
  connectPostgres,
  createEmptyTestDatabase,
} from "../test-support/test-database.ts";

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
  };
}

describe("pnpm migrate", () => {
  // #319-T03
  it("applies every migration over DATABASE_URL_MIGRATE and says so, then finds nothing to do", async () => {
    const { db, url } = await createEmptyTestDatabase();
    const { out, err, io } = recorder();
    const exit = vi.spyOn(process, "exit");

    const first = await runMigrateCommand({ DATABASE_URL_MIGRATE: url }, io);

    expect(first).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toMatch(/applied \d+ migration/);
    expect(out.join("\n")).not.toContain(url);
    expect(await readSchemaStatus(db)).toEqual({ upToDate: true });

    const second = recorder();
    expect(
      await runMigrateCommand({ DATABASE_URL_MIGRATE: url }, second.io),
    ).toBe(0);
    expect(second.out.join("\n")).toContain("up to date");
    expect(exit).not.toHaveBeenCalled();
  });

  // #319-T03
  it("waits behind the advisory lock another deployment holds, and migrates once it is released", async () => {
    const { db, url } = await createEmptyTestDatabase();
    const other = connectPostgres(url, 2);
    const { io } = recorder();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = withPostgresAdvisoryLock(
      other.db,
      MIGRATE_LOCK_KEY,
      async () => {
        locked();
        await held;
      },
    );
    await lockTaken;

    let finished = false;
    const run = runMigrateCommand({ DATABASE_URL_MIGRATE: url }, io).then(
      (code) => {
        finished = true;
        return code;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(finished).toBe(false);
    expect(await readSchemaStatus(db)).toMatchObject({ upToDate: false });

    release();
    await holder;
    expect(await run).toBe(0);
    expect(await readSchemaStatus(db)).toEqual({ upToDate: true });
  });

  // #319-T03
  it("reports a failing migration by name, rolls it back and returns 1", async () => {
    const { db, url } = await createEmptyTestDatabase();
    const broken: Migration = {
      async up() {
        throw new Error("boom");
      },
    };
    const provider: MigrationProvider = {
      getMigrations: async () => ({ "0001_broken": broken }),
    };
    const { err, io } = recorder();
    const exit = vi.spyOn(process, "exit");

    const code = await runMigrateCommand({ DATABASE_URL_MIGRATE: url }, io, {
      provider,
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("MIGRATION_FAILED");
    expect(err.join("\n")).toContain("0001_broken");
    expect(err.join("\n")).not.toContain(url);
    expect(exit).not.toHaveBeenCalled();
    expect(await readSchemaStatus(db)).toMatchObject({ upToDate: false });
  });
});
