// SPDX-License-Identifier: Apache-2.0

// #499: the two reads of a claim while billing is on, so neither scans a workspace's history.
//
// - The hourly brake counts the usage records a workspace started in the last hour (`reserved_at`). The earlier index of the
//   table is `(workspace_id, review_kind, reserved_at)`, which cannot serve a range on `reserved_at` without the review kind,
//   so the count would walk every record of the workspace.
// - The monthly limit sums the `usage` entries of the journal since the start of the month. The unique index
//   `(workspace_id, type, ref_key)` finds the type but not the time.
//
// Forward only and additive: two indexes, no column and no row, so the version that is still running is not affected while
// the migration runs. The same on both engines.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createIndex("usage_records_workspace_reserved_at")
      .on("usage_records")
      .columns(["workspace_id", "reserved_at"])
      .execute();
    await db.schema
      .createIndex("billing_journal_entries_type_created")
      .on("billing_journal_entries")
      .columns(["workspace_id", "type", "created_at"])
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex("billing_journal_entries_type_created").execute();
    await db.schema.dropIndex("usage_records_workspace_reserved_at").execute();
  },
};
