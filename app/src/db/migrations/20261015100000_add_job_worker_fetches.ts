// SPDX-License-Identifier: Apache-2.0

// #320: how many times the Worker of a claim fetched the job details (at most three per claim). The
// counter is on the job row, next to the lease token it belongs to, and the claim resets it, so a job
// that is claimed again starts at zero.
//
// Forward-only and safe next to a previous release: the column has a default, so an insert or a claim of
// an older app instance that does not name it leaves it at 0, and it reads columns by name, so it never
// sees this one. Nothing reads the count except the Worker API.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("jobs")
      .addColumn("worker_fetches", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .execute();
  },

  async down(db) {
    await db.schema.alterTable("jobs").dropColumn("worker_fetches").execute();
  },
};
