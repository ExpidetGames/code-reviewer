// SPDX-License-Identifier: LicenseRef-Proprietary

// #432: what a run was given, in its usage record (ADR 0005, 2.8 step 5). Three nullable text columns on
// `usage_records`: `catalog_entry_id` and `catalog_entry_name` (the entry a managed run used and its name as it was when the
// run was claimed, so a rename does not rewrite history) and `llm_provider` (the provider the run was sent to; operator
// data, never served to a member). `model_tier` stays for the rows that carry it.
//
// Forward-only and safe next to a previous release: columns only, nullable without a default, so no existing row is
// touched and an insert of an older app instance that does not name them leaves them NULL; that instance reads columns by
// name, so it never sees these. No index: nothing looks a record up by these columns.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    for (const column of [
      "catalog_entry_id",
      "catalog_entry_name",
      "llm_provider",
    ])
      await db.schema
        .alterTable("usage_records")
        .addColumn(column, "text")
        .execute();
  },

  async down(db) {
    for (const column of [
      "catalog_entry_id",
      "catalog_entry_name",
      "llm_provider",
    ])
      await db.schema.alterTable("usage_records").dropColumn(column).execute();
  },
};
