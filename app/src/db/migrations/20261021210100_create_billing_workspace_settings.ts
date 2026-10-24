// SPDX-License-Identifier: LicenseRef-Proprietary

// The settings a workspace makes for its own billing (ADR 0006, 2.9; #499): today the optional monthly total limit, in
// micro-USD, or null for none (the default). One row per workspace, created by the first change; a workspace without a row
// has no limit. The table is new and empty and no existing row is touched, so an app of the previous release keeps working on
// the same database.
//
// The limit is an integer that must not be 32 bit (a limit above USD 2,147 is a normal one): `bigint` on Postgres, which hands
// it back as text, and SQLite's 64 bit `integer`, the same value on both engines. It is positive when set: a limit of zero
// would be a pause nobody can see, and "no limit" is null. `updated_by` is the user who last changed it; the user may be
// deleted later, the row stays (set null).
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { databaseDriver } from "../driver.ts";

export const migration: Migration = {
  async up(db) {
    const money = databaseDriver(db) === "postgres" ? "bigint" : "integer";
    await db.schema
      .createTable("billing_workspace_settings")
      .addColumn("workspace_id", "text", (column) =>
        column.primaryKey().notNull().references("workspaces.id"),
      )
      .addColumn("monthly_limit_micro_usd", money)
      .addColumn("updated_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "billing_workspace_settings_limit_check",
        sql`monthly_limit_micro_usd is null or monthly_limit_micro_usd > 0`,
      )
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("billing_workspace_settings").execute();
  },
};
