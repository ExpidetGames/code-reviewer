// SPDX-License-Identifier: Apache-2.0

// `setup_codes`: the first-run setup code of a serverless deployment (#321, src/setup/database-code-store.ts).
// A server keeps its setup code in the memory of its one process; serverless instances share nothing
// but the database, so the code, its expiry and its counters live here. At most one row: `pnpm setup-code`
// replaces it. `code_hash` is a keyed hash (HMAC with a key derived from `APP_SECRET`), never the code.
// Additive only: an instance from before this migration never reads the table.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("setup_codes")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("code_hash", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("used_at", "text")
      .addColumn("failures", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("window_started_at", "text")
      .addColumn("attempts_in_window", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("setup_codes").execute();
  },
};
