// SPDX-License-Identifier: LicenseRef-Proprietary

// Settings of the whole instance, one row per setting, the value as JSON text. The first one is
// `review_defaults`: the global default values of the review settings, holding only the fields
// somebody changed (src/review-settings/README.md). A later setting of the instance is a new key,
// not a new table. `updated_by` is the GitHub login of the person who saved it last, for the record
// (every person on the allow list may change these settings).
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("app_settings")
      .addColumn("key", "text", (column) => column.primaryKey())
      // JSON text.
      .addColumn("value", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("updated_by", "text")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("app_settings").execute();
  },
};
