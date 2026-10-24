// SPDX-License-Identifier: LicenseRef-Proprietary

// #658: an index on `jobs.superseded_by`. The column refers to `jobs.id`, so deleting a job makes the database look for a job that
// still points at it; without an index that is a scan of the whole table for every deleted job, and deleting a workspace with
// 20 000 jobs took 13.6 s (1.7 s with the index) while it held the Dynamic gate. The only earlier index of the column
// (`jobs_old_superseded_by`, 20261011160100) served the temporary table of the customer-data migration and went with it.
//
// Forward only and additive: one index, no column and no row, so the version that is still running is not affected. It is a plain
// `create index`, like every index migration of this repository: the migrator runs a migration inside a transaction, which
// `CREATE INDEX CONCURRENTLY` cannot. The write lock the plain form takes on `jobs` lasts as long as the build; on a column that is
// null for almost every row (only a job that a newer push replaced has a value) that is a fraction of a second for a table of
// hundreds of thousands of jobs, and the hosted deployment's `jobs` table is far smaller than that.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createIndex("jobs_superseded_by")
      .ifNotExists()
      .on("jobs")
      .column("superseded_by")
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex("jobs_superseded_by").ifExists().execute();
  },
};
