// SPDX-License-Identifier: Apache-2.0

// Integration tests that need a real Postgres run only when one is configured: set
// `TEST_DATABASE_URL` to a Postgres URL (CI does, with a service container; a developer starts a
// throwaway container by hand). Every test gets a database of its own, created empty and dropped
// afterwards, so tests never share a schema and a parallel worker cannot interfere.
import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { migrateToLatest } from "../db/migrate.ts";
import type { Database } from "../db/schema.ts";
import { cleanUpAfterTest } from "./test-database.ts";

/** The configured Postgres URL, or undefined when no Postgres test database is configured. */
export function postgresTestUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) return undefined;
  if (!/^postgres(ql)?:\/\//.test(url))
    throw new Error(
      "TEST_DATABASE_URL must be a postgres:// or postgresql:// URL.",
    );
  return url;
}

/** True when a Postgres test database is configured; tests are skipped without one. */
export function hasPostgres(): boolean {
  return postgresTestUrl() !== undefined;
}

export type PostgresTestDatabase = {
  db: Kysely<Database>;
  /** The URL of this database alone. */
  url: string;
  /** The name of this database (for the admin connection). */
  database: string;
  /** Drops the database; called automatically after the test. */
  drop: () => Promise<void>;
};

/** One connection to the server's own database, for creating and dropping test databases. */
function adminPool(base: URL): Pool {
  const pool = new Pool({ connectionString: base.toString(), max: 2 });
  // A terminated connection (a drop of another database, a force end) must not crash the run.
  pool.on("error", () => undefined);
  return pool;
}

function withDatabase(base: URL, database: string): string {
  const url = new URL(base.toString());
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * A fresh Postgres database, migrated to the latest schema, removed after the test. Pass
 * `{ migrate: false }` for a test that must watch the migration itself (an empty database).
 */
export async function createPostgresTestDatabase(
  options: { migrate?: boolean; poolMax?: number } = {},
): Promise<PostgresTestDatabase> {
  const configured = postgresTestUrl();
  if (!configured)
    throw new Error(
      "No Postgres test database is configured: set TEST_DATABASE_URL.",
    );
  const base = new URL(configured);
  const database = `cr_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = adminPool(base);
  await admin.query(`create database "${database}"`);
  await admin.end();

  const url = withDatabase(base, database);
  const pool = new Pool({ connectionString: url, max: options.poolMax ?? 4 });
  pool.on("error", () => undefined);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  const drop = async (): Promise<void> => {
    await db.destroy();
    const closer = adminPool(base);
    // force: end any connection a leaked pool still holds, so the drop cannot hang.
    await closer.query(`drop database if exists "${database}" with (force)`);
    await closer.end();
  };

  try {
    if (options.migrate !== false) await migrateToLatest(db);
  } catch (error) {
    await drop();
    throw error;
  }
  cleanUpAfterTest(drop);
  return { db, url, database, drop };
}

/** A second, independent connection to the same Postgres test database, for two-instance tests. */
export function connectPostgres(
  url: string,
  poolMax = 4,
): { db: Kysely<Database>; close: () => Promise<void> } {
  const pool = new Pool({ connectionString: url, max: poolMax });
  pool.on("error", () => undefined);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const close = async (): Promise<void> => {
    await db.destroy();
  };
  cleanUpAfterTest(close);
  return { db, close };
}
