// SPDX-License-Identifier: LicenseRef-Proprietary

// Runs jobs one after the other per key, in the order they were asked for. Two syncs of the same
// installation (a start-up sync and a webhook, say) must not interleave: each reads GitHub's current
// list inside the lock, so the one that runs last also saw the newest list.
//
// Several app instances run at once, so the lock is in the database: `createPostgresKeyedLock` holds a
// session-level advisory lock keyed on the installation, on a connection of its own, which every instance
// sees. `createKeyedLock` is the in-process version that tests with one process use.
import type { Kysely } from "kysely";
import { withPostgresAdvisoryLock } from "../../db/postgres.ts";
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

/**
 * The database lock: a session-level Postgres advisory lock keyed on
 * `hashtextextended(key, 0)` (the installation). Two app instances that take the same key run one
 * after the other, whichever process they are in. The lock is held on a dedicated connection of its
 * own (`withPostgresAdvisoryLock`), never the main pool: the job keeps doing its own database work
 * while the lock is held, and a held pooled connection would deadlock an about-`poolMax` burst of
 * syncs. The lock is released and the connection closed when the job ends, also when it throws.
 */
export function createPostgresKeyedLock(db: Kysely<Database>): KeyedLock {
  return {
    run<T>(key: string, job: () => Promise<T>): Promise<T> {
      return withPostgresAdvisoryLock(db, key, job);
    },
  };
}

/** The lock a service on this connection uses: the advisory lock. */
export function defaultKeyedLock(db: Kysely<Database>): KeyedLock {
  return createPostgresKeyedLock(db);
}
