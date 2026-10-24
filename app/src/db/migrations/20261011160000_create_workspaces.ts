// SPDX-License-Identifier: LicenseRef-Proprietary

// Workspaces own the customer data (see docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.6 and 2.7): connections, repositories, projects, jobs and the review defaults belong to exactly
// one workspace, and a user reaches a workspace as a member with a role.
//
// This migration only creates the two tables. Who is a member is decided by the import of an
// existing installation and by the workspaces feature, never by a migration. The tables are empty
// until then. `workspace_members` is unique per (workspace, user) and its role is restricted to the
// three roles of the decision record by the database itself.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("workspaces")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("slug", "text", (column) => column.notNull().unique())
      // The user who created it; null for the workspace made by a migration or the setup.
      .addColumn("created_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("workspace_members")
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id").onDelete("cascade"),
      )
      .addColumn("user_id", "text", (column) =>
        column.notNull().references("users.id").onDelete("cascade"),
      )
      .addColumn("role", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("workspace_members_pk", [
        "workspace_id",
        "user_id",
      ])
      .addCheckConstraint(
        "workspace_members_role_check",
        // Written out because a check constraint cannot take bound values. The same list is
        // WORKSPACE_ROLES in src/workspaces/roles.ts; a test compares the two.
        sql`role in ('owner', 'admin', 'member')`,
      )
      .execute();

    // "Which workspaces does this user belong to?"
    await db.schema
      .createIndex("workspace_members_user")
      .on("workspace_members")
      .column("user_id")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("workspace_members").execute();
    await db.schema.dropTable("workspaces").execute();
  },
};
