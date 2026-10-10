// Connections to git platforms (see src/integrations/README.md). `config` and `credentials` are JSON
// text; `credentials` and `webhook_secret` stay empty for a GitHub App and are reserved for token
// integrations (encrypted before they are used). A platform connection exists once per type.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("integrations")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("type", "text", (column) => column.notNull())
      .addColumn("display_name", "text", (column) => column.notNull())
      .addColumn("external_id", "text")
      .addColumn("config", "text", (column) => column.notNull())
      .addColumn("credentials", "text")
      .addColumn("webhook_secret", "text")
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createIndex("integrations_type_external_id_unique")
      .on("integrations")
      .columns(["type", "external_id"])
      .unique()
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("integrations").execute();
  },
};
