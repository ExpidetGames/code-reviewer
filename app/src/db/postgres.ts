// SPDX-License-Identifier: Apache-2.0

// The Postgres side of the connection: Kysely's Postgres dialect over the `pg` driver's pool
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.1). The pool size comes from the
// configuration; an idle pool error (a connection the server dropped) is logged by Kysely's own
// events, never by crashing the process.
import "server-only";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import {
  describeDatabaseTarget,
  type PostgresDatabaseConfig,
} from "./config.ts";
import { DatabaseError, describeError } from "./errors.ts";
import type { Database } from "./schema.ts";

export function openPostgresDatabase(
  config: PostgresDatabaseConfig,
): Kysely<Database> {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
  });
  // An error on an idle client (the server went away) must not become an unhandled event.
  pool.on("error", () => undefined);
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
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
