// SPDX-License-Identifier: Apache-2.0

// A lock that is tried, not waited for: the cron sweep (#328) runs once a minute on whichever serverless
// instance the platform picks, and a run that finds another one still working must skip, not queue up behind it.
//
// Postgres: a transaction advisory lock (`pg_try_advisory_xact_lock`) on a dedicated client that is not part of
// the pool (`tryWithPostgresAdvisoryLock`, postgres.ts), because the work does its own database work from the pool
// and a pooled connection held across it could starve it (with a pool of one, deadlock it). The lock is
// released when the work ends, when the client is closed or when its connection dies, so a crashed instance
// cannot leave it locked (a transaction lock, not a session lock, so a pooler cannot strand it). Keys are two integers; the namespaces in use are listed here so that none is used
// twice: 195 is the Dynamic Review gate (`dynamic-review-lock.ts`), 328 the sweep (id 1) and the repair work
// of other requests (id 2, #395), 548 the models.dev fetch (id 1, #548).
//
// SQLite: one process owns the file, so a set of keys held in memory is the same guarantee.
import type { Kysely } from "kysely";
import { databaseDriver } from "./driver.ts";
import { tryWithPostgresAdvisoryLock } from "./postgres.ts";
import type { Database } from "./schema.ts";

export type LockKey = { namespace: number; id: number };

/** The one run of the cron sweep at a time (#328). */
export const SWEEP_LOCK: LockKey = { namespace: 328, id: 1 };

/**
 * The one run of the repair work of the requests that touch the database at a time (#395). A key of its own: the
 * sweep runs every two hours and is not repeated by the platform, so a run of the repair work that held the sweep's
 * key at that moment would make the whole sweep a no-op. The two may overlap; each step of both is safe to repeat.
 */
export const OPPORTUNISTIC_LOCK: LockKey = { namespace: 328, id: 2 };

/** The one run of the models.dev fetch at a time (#548); the sweep calls it while it holds `SWEEP_LOCK`. */
export const MODELS_DEV_LOCK: LockKey = { namespace: 548, id: 1 };

export type TryLockResult<T> =
  { acquired: true; value: T } | { acquired: false };

const heldOnSqlite = new WeakMap<object, Set<string>>();

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
    ? tryWithPostgresAdvisoryLock(db, key, work)
    : tryOnSqlite(db, key, work);
}
