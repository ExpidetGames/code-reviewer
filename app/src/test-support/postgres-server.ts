// SPDX-License-Identifier: LicenseRef-Proprietary

// The Postgres server of the integration tests and the plain helpers around it. No test framework is imported here:
// the global setup (which runs outside a test suite) uses these too; the per-test cleanup lives in test-database.ts.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";

/** The Postgres server the tests use: `TEST_DATABASE_URL`, or the default of the throwaway container. */
export function postgresTestUrl(): string {
  const url =
    process.env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL;
  if (!/^postgres(ql)?:\/\//.test(url))
    throw new Error(
      "TEST_DATABASE_URL must be a postgres:// or postgresql:// URL.",
    );
  return url;
}

/** One connection to the server's own database, for creating and dropping test databases. */
export function adminPool(base: URL | string): Pool {
  const pool = new Pool({ connectionString: base.toString(), max: 2 });
  // A terminated connection (a drop of another database, a force end) must not crash the run.
  pool.on("error", () => undefined);
  return pool;
}

export function withDatabase(base: URL | string, database: string): string {
  const url = new URL(base.toString());
  url.pathname = `/${database}`;
  return url.toString();
}

export function newDatabaseName(prefix = "cr_test"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
