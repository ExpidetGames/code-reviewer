// SPDX-License-Identifier: Apache-2.0

// #273: why a usage record was settled without a report of its run (`no_result`, src/usage/README.md). A run
// that reported its usage, failed or not, has no reason; a job whose runner never reported (it died, its lease
// ran out on the last attempt, it ran past the hard limit) is settled with everything unknown and says so here.
//
// Forward-only and safe next to a previous release: the column is nullable, so a record that an older app
// instance writes or voids leaves it empty, and an older instance reads columns by name and never sees it. The
// check only restates the one value the code writes (SETTLED_REASONS in src/usage/usage-records.ts); a
// column check refers to its own column only, which both SQLite and Postgres accept on `add column`.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("usage_records")
      .addColumn("settled_reason", "text", (column) =>
        column.check(
          sql`settled_reason is null or settled_reason in ('no_result')`,
        ),
      )
      .execute();
  },

  async down(db) {
    await db.schema
      .alterTable("usage_records")
      .dropColumn("settled_reason")
      .execute();
  },
};
