// A project is a repository the instance reviews. The row is created the first time a repository is
// activated and kept from then on: deactivating sets `active` to 0 and leaves the row (and its
// settings) in place, so activating again finds the same row. `repository_id` is unique, which is
// what makes two simultaneous activations end in exactly one project.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("projects")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("repository_id", "text", (column) =>
        column.notNull().unique().references("repositories.id"),
      )
      .addColumn("active", "integer", (column) => column.notNull())
      // JSON text: the project's setting overrides (written by the settings ticket), '{}' until then.
      .addColumn("settings", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("projects").execute();
  },
};
