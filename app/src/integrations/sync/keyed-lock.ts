// SPDX-License-Identifier: Apache-2.0

// Runs jobs one after the other per key, in the order they were asked for. Two syncs of the same
// installation (a start-up sync and a webhook, say) must not interleave: each reads GitHub's current
// list inside the lock, so the one that runs last also saw the newest list.
//
// On SQLite the lock is in-process (`sharedKeyedLock`, kept on `globalThis`): the single writer and
// `begin immediate` already serialize writers across processes. On Postgres several app instances run
// at once, so the lock must be in the database: `createPostgresKeyedLock` takes a transaction-scoped
// advisory lock keyed on the installation, which every instance sees. `defaultKeyedLock` picks.
import { sql, type Kysely } from "kysely";
import { databaseDriver } from "../../db/driver.ts";
import type { Database } from "../../db/schema.ts";

export type KeyedLock = {
  run<T>(key: string, job: () => Promise<T>): Promise<T>;
};

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(key, job) {
      const previous = tails.get(key) ?? Promise.resolve();
      // A failed job must not block the next one.
      const result = previous.then(job, job);
      const tail = result.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
  };
}

// One lock for the whole process. Next.js may load `instrumentation.ts` and the route handlers as
// separate module graphs, each with its own copy of this module, so the lock lives on `globalThis`
// (like the database connection): the start-up sync, a webhook and the button all queue on it.
const SHARED_LOCK = Symbol.for("code-reviewer.integration-sync-lock");

export function sharedKeyedLock(): KeyedLock {
  const holder = globalThis as typeof globalThis & {
    [SHARED_LOCK]?: KeyedLock;
  };
  holder[SHARED_LOCK] ??= createKeyedLock();
  return holder[SHARED_LOCK];
}

/**
 * The database lock of the large topology: a transaction-scoped Postgres advisory lock keyed on
 * `hashtextextended(key, 0)` (the installation). Two app instances that take the same key run one
 * after the other, whichever process they are in. The lock ends with its transaction, so a crash
 * cannot leave it held, and the job itself runs outside that transaction (it may take its own).
 */
export function createPostgresKeyedLock(db: Kysely<Database>): KeyedLock {
  return {
    run<T>(key: string, job: () => Promise<T>): Promise<T> {
      return db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
          trx,
        );
        return job();
      });
    },
  };
}

/** The lock a service on this connection uses: the advisory lock on Postgres, the shared one on SQLite. */
export function defaultKeyedLock(db: Kysely<Database>): KeyedLock {
  return databaseDriver(db) === "postgres"
    ? createPostgresKeyedLock(db)
    : sharedKeyedLock();
}
