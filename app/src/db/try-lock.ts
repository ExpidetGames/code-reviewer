// SPDX-License-Identifier: Apache-2.0

// A lock that is tried, not waited for: the cron sweep (#328) runs once a minute on whichever serverless
// instance the platform picks, and a run that finds another one still working must skip, not queue up behind it.
//
// Postgres: a transaction advisory lock (`pg_try_advisory_xact_lock`) held by one connection for as long as the
// work runs. It is released by the end of the transaction, so a crashed instance or a lost connection frees it
// and no key can stay locked. The work itself uses the pool's other connections; the lock transaction touches
// no table. Keys are two integers; the namespaces in use are listed here so that none is used twice: 195 is
// the Dynamic Review gate (`dynamic-review-lock.ts`), 328 the sweep.
//
// SQLite: one process owns the file, so a set of keys held in memory is the same guarantee.
import { sql, type Kysely } from "kysely";
import { databaseDriver } from "./driver.ts";
import type { Database } from "./schema.ts";

export type LockKey = { namespace: number; id: number };

/** The one run of the cron sweep at a time (#328). */
export const SWEEP_LOCK: LockKey = { namespace: 328, id: 1 };

export type TryLockResult<T> =
  { acquired: true; value: T } | { acquired: false };

const heldOnSqlite = new WeakMap<object, Set<string>>();

async function tryOnPostgres<T>(
  db: Kysely<Database>,
  key: LockKey,
  work: () => Promise<T>,
): Promise<TryLockResult<T>> {
  const attempt = async (
    executor: Kysely<Database>,
  ): Promise<TryLockResult<T>> => {
    const { rows } = await sql<{ locked: boolean }>`
      select pg_try_advisory_xact_lock(${key.namespace}, ${key.id}) as locked`.execute(
      executor,
    );
    if (rows[0]?.locked !== true) return { acquired: false };
    return { acquired: true, value: await work() };
  };
  // Inside a transaction the lock lasts as long as that one; the caller owns its end.
  return db.isTransaction ? attempt(db) : db.transaction().execute(attempt);
}

async function tryOnSqlite<T>(
  db: Kysely<Database>,
  key: LockKey,
  work: () => Promise<T>,
): Promise<TryLockResult<T>> {
  let held = heldOnSqlite.get(db);
  if (held === undefined) {
    held = new Set();
    heldOnSqlite.set(db, held);
  }
  const name = `${String(key.namespace)}:${String(key.id)}`;
  if (held.has(name)) return { acquired: false };
  held.add(name);
  try {
    return { acquired: true, value: await work() };
  } finally {
    held.delete(name);
  }
}

/**
 * Runs `work` if nobody holds `key`, and says so; otherwise returns at once without running it. An error of
 * `work` is passed on and frees the key.
 */
export function tryWithLock<T>(
  db: Kysely<Database>,
  key: LockKey,
  work: () => Promise<T>,
): Promise<TryLockResult<T>> {
  return databaseDriver(db) === "postgres"
    ? tryOnPostgres(db, key, work)
    : tryOnSqlite(db, key, work);
}
