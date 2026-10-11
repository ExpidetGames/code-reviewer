// SPDX-License-Identifier: Apache-2.0

// The repositories each integration can see (for a GitHub App: the repositories of an installation).
// A repository that disappears from the platform is marked inactive, never deleted, because
// projects and past reviews refer to it. One row per (integration, platform id), so syncing the
// same repository twice cannot create a duplicate.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("repositories")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("integration_id", "text", (column) =>
        column.notNull().references("integrations.id"),
      )
      .addColumn("external_id", "text", (column) => column.notNull())
      .addColumn("full_name", "text", (column) => column.notNull())
      .addColumn("url", "text", (column) => column.notNull())
      .addColumn("active", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createIndex("repositories_integration_external_id_unique")
      .on("repositories")
      .columns(["integration_id", "external_id"])
      .unique()
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("repositories").execute();
  },
};
