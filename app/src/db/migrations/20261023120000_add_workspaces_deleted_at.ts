// SPDX-License-Identifier: Apache-2.0

// #658: a deleted workspace stays as a row with the time it was deleted. The billing journal is append-only and holds a
// foreign key to the workspace (the money history must outlive the customer's data), so the row cannot go; deletion removes
// everything else and anonymises this row (name, slug), and `deleted_at` is what tells the rest of the code it is a tombstone
// (no default workspace for a new installation, not counted as a workspace of the instance).
//
// Forward-only and safe next to a previous release: the column is nullable and an older instance never writes or reads it.
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
