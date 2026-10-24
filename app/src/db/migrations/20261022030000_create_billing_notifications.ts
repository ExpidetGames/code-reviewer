// SPDX-License-Identifier: LicenseRef-Proprietary

// What a workspace has been told about its balance (ADR 0006, D9; #506): one row for each workspace and kind, `low` (the
// balance fell below the threshold the admin set) and `empty` (it reached zero or went below). `state` is `armed` while the
// workspace may be told the next time the balance drops into the state, and `sent` from the crossing until a credit lifts the
// balance out of it again. `delivery` follows the mail of a crossing: `due` is written in the transaction that moved the
// balance, `sending` is the claim of the one process that sends it, and `delivered` or `failed` is what it found out; `none` is
// a crossing that is not mailed (a credit that landed in the state) or no crossing. The table is new and empty and no
// existing row is touched, so an app of the previous release keeps working on the same database.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("billing_notifications")
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("kind", "text", (column) => column.notNull())
      .addColumn("state", "text", (column) => column.notNull())
      .addColumn("sent_at", "text")
      .addColumn("delivery", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("billing_notifications_pkey", [
        "workspace_id",
        "kind",
      ])
      .addCheckConstraint(
        "billing_notifications_kind_check",
        sql`kind in ('low', 'empty')`,
      )
      .addCheckConstraint(
        "billing_notifications_state_check",
        sql`state in ('armed', 'sent')`,
      )
      .addCheckConstraint(
        "billing_notifications_delivery_check",
        sql`delivery in ('none', 'due', 'sending', 'delivered', 'failed')`,
      )
      .execute();
    // The drain asks for the few rows that wait for a mail: a partial index keeps the table out of that read.
    await db.schema
      .createIndex("billing_notifications_due")
      .on("billing_notifications")
      .columns(["workspace_id", "kind"])
      .where(sql.ref("delivery"), "=", "due")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("billing_notifications").execute();
  },
};
