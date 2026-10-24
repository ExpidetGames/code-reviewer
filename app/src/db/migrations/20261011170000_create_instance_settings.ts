// SPDX-License-Identifier: LicenseRef-Proprietary

// `instance_settings`: the settings of the whole instance, one row per setting with a JSON value
// (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.2 and 2.7). The first two rows are
// the explicit markers of the first-run setup: `setup_completed_at` (null until the wizard has
// finished) and `import_state` (`none` or `done`). The state is never inferred from whether a row
// exists: a database from before this table has neither marker, which reads as null and `none`.
// `updated_by` is the id of the user who changed the setting (null for the system); the user may be
// deleted later, the row stays.
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("instance_settings")
      .addColumn("key", "text", (column) => column.primaryKey())
      .addColumn("value", "text", (column) => column.notNull())
      .addColumn("updated_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("instance_settings").execute();
  },
};
