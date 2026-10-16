// SPDX-License-Identifier: Apache-2.0

// #397: whether the holder of a claim understands that its run can be superseded (the feature `supersede` of
// #396). A running job is superseded only when it is set, so a runner or Worker of an earlier release, which would
// carry on and publish a stale review, never is: the new job simply waits for it as before. The claim sets it from
// the features of the claim request, and the Worker's job details request sets it for a Worker.
//
// Forward-only and safe next to a previous release: the column has a default, so an insert or a claim of an older
// app instance that does not name it leaves it at 0 (that instance never supersedes a running job), and it reads
// columns by name, so it never sees this one.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("jobs")
      .addColumn("accepts_supersede", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .execute();
  },

  async down(db) {
    await db.schema
      .alterTable("jobs")
      .dropColumn("accepts_supersede")
      .execute();
  },
};
