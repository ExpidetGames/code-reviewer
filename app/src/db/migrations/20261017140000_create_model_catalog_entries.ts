// SPDX-License-Identifier: Apache-2.0

// `model_catalog_entries` (#425, docs/decisions/0005-providers-model-catalog-and-paddle-billing.md, 2.6): the operator's
// list of the models that workspaces on the operator's key may use (src/model-catalog/README.md). The `name` is free
// text that members see; `provider` and `model_id` never leave the server. `name_key` is the name folded to lower case
// and unique, stored so that the uniqueness is the same on SQLite and Postgres without an expression index
// (src/db/README.md, "Portable schema conventions"). `serves_diff` and `serves_dynamic` are 0 or 1 and at least one is 1.
// `status` is `draft`, `released` or `retired`; `updated_by` is the user who changed the row last. The table is new and
// empty, and no existing row is touched, so an app of the previous release (which never reads it) keeps working on the
// same database. Nothing in the table is customer data: no workspace owns an entry.
//
// The checks restate what the code keeps true; the lists are `CATALOG_STATUSES` and `CATALOG_KINDS` in the code. The
// provider has no check, because the list of providers grows with the code (it is validated there, and again on read).
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("model_catalog_entries")
      .addColumn("id", "text", (column) => column.primaryKey().notNull())
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("name_key", "text", (column) => column.notNull())
      .addColumn("description", "text")
      .addColumn("provider", "text", (column) => column.notNull())
      .addColumn("model_id", "text", (column) => column.notNull())
      .addColumn("serves_diff", "integer", (column) => column.notNull())
      .addColumn("serves_dynamic", "integer", (column) => column.notNull())
      .addColumn("status", "text", (column) =>
        column.notNull().defaultTo("draft"),
      )
      .addColumn("sort_order", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("updated_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addCheckConstraint(
        "model_catalog_entries_status_check",
        sql`status in ('draft', 'released', 'retired')`,
      )
      .addCheckConstraint(
        "model_catalog_entries_serves_check",
        sql`serves_diff in (0, 1) and serves_dynamic in (0, 1) and (serves_diff = 1 or serves_dynamic = 1)`,
      )
      .execute();

    // Names are unique across entries, whatever the case (decision C3).
    await db.schema
      .createIndex("model_catalog_entries_name_key")
      .on("model_catalog_entries")
      .column("name_key")
      .unique()
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("model_catalog_entries").execute();
  },
};
