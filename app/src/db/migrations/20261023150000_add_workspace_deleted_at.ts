// SPDX-License-Identifier: LicenseRef-Proprietary

// #658: the mark of a deleted workspace. Deleting a workspace removes its data but keeps the `workspaces` row as a tombstone
// (the billing journal and the top-up intents point at it), anonymised; `deleted_at` is when that happened and is what every
// reader uses to tell a tombstone from a workspace (`NOT_DELETED` in src/db/repositories/workspaces-repository.ts). Forward
// only and additive: one nullable column, no row touched, so a workspace that exists before is alive and the version that is
// still running keeps working on the same database. The same on both engines.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("workspaces")
      .addColumn("deleted_at", "text")
      .execute();
  },

  async down(db) {
    await db.schema.alterTable("workspaces").dropColumn("deleted_at").execute();
  },
};
