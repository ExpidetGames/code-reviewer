// SPDX-License-Identifier: Apache-2.0

// The try-lock of the cron sweep (#328): at most one holder of a key at any moment, a second caller is told
// "not acquired" at once instead of waiting, and the key is free again however the holder ended. On SQLite
// (one process) and, when TEST_DATABASE_URL is set, on Postgres, where it is `pg_try_advisory_xact_lock` on a
// dedicated connection next to the pool, which may hold a single connection (CI).
import { sql, type Kysely } from "kysely";
import { describe, expect, it as vitestIt } from "vitest";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import type { Database } from "./schema.ts";
import { OPPORTUNISTIC_LOCK, SWEEP_LOCK, tryWithLock } from "./try-lock.ts";

const KEY = { namespace: 328, id: 1 } as const;

const databases: Array<
  [string, (() => Promise<Kysely<Database>>) | undefined]
> = [
  ["SQLite", async () => (await createTestDatabase()).db],
  [
    "Postgres",
    hasPostgres()
      ? async () => (await createPostgresTestDatabase({ poolMax: 6 })).db
      : undefined,
  ],
];

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe.each(databases)("the try-lock on %s", (name, open) => {
  const it =
    name === "Postgres" && open === undefined ? vitestIt.skip : vitestIt;
  const database = async (): Promise<Kysely<Database>> => {
    if (open === undefined) throw new Error("No database for this suite.");
    return open();
  };

  // #328-T06
  it("runs the work of the first caller and tells a second, overlapping caller that it did not get the lock", async () => {
    const db = await database();
    const held = gate();
    const started = gate();

    const first = tryWithLock(db, KEY, async () => {
      started.open();
      await held.opened;
      return "first";
    });
    await started.opened;
    const second = await tryWithLock(db, KEY, async () => "second");
    held.open();

    expect(second).toEqual({ acquired: false });
    expect(await first).toEqual({ acquired: true, value: "first" });
  });

  // #395-T11
  it("keeps the lock of the sweep and the lock of the repair work of other requests apart, so neither can make the other a no-op", async () => {
    const db = await database();
    const held = gate();
    const started = gate();

    const repair = tryWithLock(db, OPPORTUNISTIC_LOCK, async () => {
      started.open();
      await held.opened;
      return "repair";
    });
    await started.opened;
    // The cron fires while the repair work is sending: it gets its lock and does its work.
    const sweep = await tryWithLock(db, SWEEP_LOCK, async () => "sweep");
    held.open();

    expect(sweep).toEqual({ acquired: true, value: "sweep" });
    expect(await repair).toEqual({ acquired: true, value: "repair" });
    expect(SWEEP_LOCK).not.toEqual(OPPORTUNISTIC_LOCK);
  });

  // #328-T06
  it("is free again after the work finished, and after it threw", async () => {
    const db = await database();

    await expect(
      tryWithLock(db, KEY, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const again = await tryWithLock(db, KEY, async () => "again");

    expect(again).toEqual({ acquired: true, value: "again" });
  });

  // #328-T06
  it("leaves the connections of the pool to the work, even with a pool of one", async () => {
    if (open === undefined) throw new Error("No database for this suite.");
    const db =
      name === "Postgres"
        ? (await createPostgresTestDatabase({ poolMax: 1 })).db
        : await database();

    const outcome = await tryWithLock(db, KEY, async () => {
      const { rows } = await sql<{ one: number }>`select 1 as one`.execute(db);
      return rows[0]?.one;
    });

    expect(outcome).toEqual({ acquired: true, value: 1 });
  });

  // #328-T06
  it("keeps different keys apart", async () => {
    const db = await database();
    const held = gate();
    const started = gate();
    const first = tryWithLock(db, KEY, async () => {
      started.open();
      await held.opened;
    });
    await started.opened;

    const other = await tryWithLock(
      db,
      { namespace: 328, id: 2 },
      async () => "other",
    );
    held.open();
    await first;

    expect(other).toEqual({ acquired: true, value: "other" });
  });
});
