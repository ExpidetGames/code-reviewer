// SPDX-License-Identifier: Apache-2.0

// The Postgres side of the connection: Kysely's Postgres dialect over the `pg` driver's pool
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.1). The pool size comes from the
// configuration; an idle pool error (a connection the server dropped) is swallowed here. The main
// pool has a connect timeout, so an exhausted pool rejects a query instead of hanging forever.
//
// The advisory lock of the integration sync (PG-12) must NEVER use the main pool: a lock is held for
// the whole job, and the job does its own database work from the same pool, so a held pooled
// connection would starve the job and deadlock about `poolMax` concurrent syncs. `withPostgresAdvisoryLock`
// therefore opens a dedicated `pg.Client` from the same URL, holds a session-level advisory lock on
// it, and closes it in `finally`.
import "server-only";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Client, Pool } from "pg";
import {
  describeDatabaseTarget,
  type PostgresDatabaseConfig,
} from "./config.ts";
import { DatabaseError, describeError } from "./errors.ts";
import type { Database } from "./schema.ts";

/** How long a pool waits for a free connection, and a lock client for its connection, before it fails. */
const CONNECT_TIMEOUT_MS = 10_000;

// The configuration behind each open connection, so the lock can open its dedicated client from the
// same URL. A WeakMap keeps nothing alive on its own.
const CONFIG_OF = new WeakMap<Kysely<Database>, PostgresDatabaseConfig>();

export function openPostgresDatabase(
  config: PostgresDatabaseConfig,
): Kysely<Database> {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // An error on an idle client (the server went away) must not become an unhandled event.
  pool.on("error", () => undefined);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  CONFIG_OF.set(db, config);
  return db;
}

/**
 * Runs `job` while holding a session-level advisory lock keyed on `key`, on a connection of its own
 * (never the main pool). The lock is released and the client closed in `finally`, also when the job
 * throws. If the lock connection dies, Postgres releases the lock; the job is then reported as a
 * failure instead of silently running without it (the work is idempotent, so the caller retries).
 */
export async function withPostgresAdvisoryLock<T>(
  db: Kysely<Database>,
  key: string,
  job: () => Promise<T>,
): Promise<T> {
  const config = CONFIG_OF.get(db);
  if (!config)
    throw new Error(
      "The advisory lock needs a connection opened by openPostgresDatabase.",
    );
  const client = new Client({
    connectionString: config.url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // A dropped connection emits an error; swallow it here (otherwise it is unhandled) and remember it
  // so the job is not reported as protected.
  let lockLost: Error | undefined;
  client.on("error", (error: Error) => {
    lockLost = error;
  });

  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      key,
    ]);
    try {
      const result = await job();
      if (lockLost)
        throw new Error(
          `The advisory lock connection was lost, so the work ran unprotected and must be retried: ${describeError(lockLost)}`,
        );
      return result;
    } finally {
      await client
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [key])
        .catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Proves at startup that the database answers, so an unreachable server or a wrong password ends the
 * start with one clear line (naming the host and database, never the password) instead of a stack
 * trace from deep inside the first query. The health route answers 503 meanwhile; the pool connects
 * lazily, so nothing else needed to change.
 */
export async function assertPostgresReachable(
  db: Kysely<Database>,
  config: PostgresDatabaseConfig,
): Promise<void> {
  try {
    await sql`select 1`.execute(db);
  } catch (cause) {
    throw new DatabaseError(
      "DATABASE_OPEN_FAILED",
      `Cannot connect to the Postgres database at ${describeDatabaseTarget(config)}: ${describeError(cause)}`,
      { cause },
    );
  }
}
