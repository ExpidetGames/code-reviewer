// SPDX-License-Identifier: Apache-2.0

// `workspace_entitlements`: what an operator allows ONE workspace (the key it reviews with, the limits per
// period, a suspension; src/workspaces/README.md, "Entitlements"). One row per workspace; no row means "use the
// instance default, and without one the workspace is unlimited", exactly as before, so this migration adds an
// empty table and touches no existing row.
//
// `limits` is JSON text (`diffRunsPerPeriod`, `dynamicRunsPerPeriod`, `managedCostLimitMicroUsd`, each a
// count or null); `suspended` is 0 or 1. The checks restate what the repository already refuses, so a direct
// write cannot store a key mode the code does not know or a suspension code on a workspace that is not
// suspended. Written out because a check constraint cannot take bound values; the key modes are the same list
// as KEY_MODES in src/workspaces/entitlements.ts (a test compares the two). The row goes with its workspace; the
// user who saved it last is forgotten when the user is deleted.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("workspace_entitlements")
      .addColumn("workspace_id", "text", (column) =>
        column.primaryKey().references("workspaces.id").onDelete("cascade"),
      )
      .addColumn("plan_label", "text", (column) => column.notNull())
      .addColumn("key_mode", "text", (column) => column.notNull())
      .addColumn("limits", "text", (column) => column.notNull())
      .addColumn("period_start", "text", (column) => column.notNull())
      .addColumn("suspended", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("suspension_code", "text")
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("updated_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addCheckConstraint(
        "workspace_entitlements_key_mode_check",
        sql`key_mode in ('own', 'managed')`,
      )
      .addCheckConstraint(
        "workspace_entitlements_suspended_check",
        sql`suspended in (0, 1)`,
      )
      .addCheckConstraint(
        "workspace_entitlements_suspension_code_check",
        sql`suspended = 1 or suspension_code is null`,
      )
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("workspace_entitlements").execute();
  },
};
