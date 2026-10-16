// SPDX-License-Identifier: Apache-2.0

// #397: the reason of a usage record may now also be `superseded`: the run was replaced by a newer push, so it does
// not count as a run of the free quota, while its measured cost counts as usage like any other (src/usage/README.md).
// A column check cannot be widened in place on SQLite, so the column is replaced: a new one with the wider check
// gets the values of the old one, the old one is dropped (its own check goes with it) and the new one takes its
// name. The same steps work on Postgres.
//
// Safe next to a previous release: the column stays nullable, so an older app instance that writes or voids a
// record leaves it empty, and it reads the column by name. An older instance reads a `superseded` record with a
// reason it does not know and counts it as it counts any record, so upgrade every instance before superseding.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("usage_records")
      .addColumn("settled_reason_next", "text", (column) =>
        column.check(
          sql`settled_reason_next is null or settled_reason_next in ('no_result', 'superseded')`,
        ),
      )
      .execute();
    await sql`update usage_records set settled_reason_next = settled_reason`.execute(
      db,
    );
    await db.schema
      .alterTable("usage_records")
      .dropColumn("settled_reason")
      .execute();
    await db.schema
      .alterTable("usage_records")
      .renameColumn("settled_reason_next", "settled_reason")
      .execute();
  },

  async down(db) {
    // Records that say `superseded` are kept as `no_result`: the cost is unknown or measured either way.
    await db.schema
      .alterTable("usage_records")
      .addColumn("settled_reason_previous", "text", (column) =>
        column.check(
          sql`settled_reason_previous is null or settled_reason_previous in ('no_result')`,
        ),
      )
      .execute();
    await sql`update usage_records set settled_reason_previous = case when settled_reason is null then null else 'no_result' end`.execute(
      db,
    );
    await db.schema
      .alterTable("usage_records")
      .dropColumn("settled_reason")
      .execute();
    await db.schema
      .alterTable("usage_records")
      .renameColumn("settled_reason_previous", "settled_reason")
      .execute();
  },
};
