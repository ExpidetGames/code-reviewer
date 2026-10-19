// SPDX-License-Identifier: Apache-2.0

// The runs page of the instance admin (#541) lists the newest jobs of every workspace, ordered by
// `(created_at, id)`. Without an index on that order every call sorts all jobs of the instance; with it
// the newest hundred are read from the end of the index. Forward only and additive: an index, no column
// and no row, so the version that is still running is not affected while the migration runs.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createIndex("jobs_created_at_id")
      .on("jobs")
      .columns(["created_at", "id"])
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex("jobs_created_at_id").execute();
  },
};
