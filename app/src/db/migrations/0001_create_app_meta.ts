// SPDX-License-Identifier: Apache-2.0

// Proves the setup end to end: a small key/value table for facts about the installation itself.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("app_meta")
      .addColumn("key", "text", (column) => column.primaryKey())
      .addColumn("value", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("app_meta").execute();
  },
};
