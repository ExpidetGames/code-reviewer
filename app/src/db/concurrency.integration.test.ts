// Pins down how the database behaves next to a second connection or a second app instance: writes
// wait for a lock that is released in time, fail clearly when it is not, and two instances starting
// on one empty file migrate it exactly once. The other side is a real OS process, because
// better-sqlite3 blocks its own thread while waiting for a lock.
import { join } from "node:path";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { startDbProcess } from "../test-support/db-process.ts";
import { createTestDatabase, createTestDirectory, track } from "../test-support/test-database.ts";
import { openDatabase } from "./connection.ts";
import { migrationProvider } from "./migrations/index.ts";
import { createAppMetaRepository } from "./repositories/app-meta-repository.ts";

describe("writing while another connection holds the write lock", () => {
  // CR-15-T07
  it("waits for a lock that is released within the busy timeout and then succeeds", async () => {
    const { db, config } = await createTestDatabase({ busyTimeoutMs: 5000 });
    const holder = startDbProcess(["hold-lock", config.path, "300"]);
    expect(await holder.nextLine()).toBe("locked");
    const started = Date.now();

    await createAppMetaRepository(db).set("k", "v");

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(await holder.nextLine()).toBe("released");
    expect(await createAppMetaRepository(db).get("k")).toBe("v");
  });

  // CR-15-T08
  it("fails with SQLITE_BUSY after the busy timeout instead of waiting forever", async () => {
    const { db, config } = await createTestDatabase({ busyTimeoutMs: 200 });
    const holder = startDbProcess(["hold-lock", config.path, "0"]);
    expect(await holder.nextLine()).toBe("locked");
    const started = Date.now();

    const write = createAppMetaRepository(db).set("k", "v");

    await expect(write).rejects.toMatchObject({ code: "SQLITE_BUSY", message: /database is locked/ });
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(150);
    expect(waited).toBeLessThan(3000);
    holder.closeInput();
    expect(await holder.nextLine()).toBe("released");
  });

  // CR-15-T07
  it("waits for the lock in a transaction too, because transactions take the lock up front", async () => {
    const { db, config } = await createTestDatabase({ busyTimeoutMs: 5000 });
    const holder = startDbProcess(["hold-lock", config.path, "300"]);
    expect(await holder.nextLine()).toBe("locked");

    await db.transaction().execute(async (trx) => {
      const before = await createAppMetaRepository(trx).get("k");
      await createAppMetaRepository(trx).set("k", before ?? "first");
    });

    expect(await createAppMetaRepository(db).get("k")).toBe("first");
  });
});

describe("two app instances starting on the same empty file", () => {
  // CR-15-T11
  it("apply every migration exactly once and both start without an error", async () => {
    const directory = await createTestDirectory();
    const path = join(directory, "app.db");
    const first = startDbProcess(["migrate", path]);
    const second = startDbProcess(["migrate", path]);
    expect(await first.nextLine()).toBe("ready");
    expect(await second.nextLine()).toBe("ready");

    const startAt = Date.now() + 300;
    first.send(`go ${startAt}`);
    second.send(`go ${startAt}`);
    const results = [JSON.parse(await first.nextLine()), JSON.parse(await second.nextLine())] as Array<{
      applied?: string[];
      error?: string;
    }>;

    expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    const expected = Object.keys(await migrationProvider.getMigrations()).sort();
    // Each migration ran in exactly one of the two processes.
    expect(results.flatMap((result) => result.applied ?? []).sort()).toEqual(expected);
    const db = track(openDatabase({ path, busyTimeoutMs: 1000 }));
    const { rows } = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db);
    expect(rows.map((row) => row.name)).toEqual(expected);
    expect((await sql`select name from sqlite_master where name = 'app_meta'`.execute(db)).rows).toHaveLength(1);
  });
});
