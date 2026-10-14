// SPDX-License-Identifier: Apache-2.0

// Which engine a Kysely connection speaks. Almost nothing in the app needs to know: the schema, the
// query builder and the codecs are the same on both. The one exception is the claim of a job, whose
// statement must use SQLite's single-writer behavior on one and `FOR UPDATE SKIP LOCKED` on the
// other.

export type DatabaseDriver = "sqlite" | "postgres";

/**
 * The engine behind a connection, read from Kysely's own dialect adapter: its SQLite adapter is the
 * only one that reports a single connection (it holds one file handle), while the Postgres adapter
 * supports several. No round trip, so it can decide the SQL of a statement.
 */
export function databaseDriver(db: {
  getExecutor(): {
    adapter: { readonly supportsMultipleConnections?: boolean };
  };
}): DatabaseDriver {
  return db.getExecutor().adapter.supportsMultipleConnections === false
    ? "sqlite"
    : "postgres";
}
