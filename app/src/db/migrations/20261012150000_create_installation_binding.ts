// SPDX-License-Identifier: Apache-2.0

// The two tables behind the binding of GitHub App installations to workspaces (docs/decisions/0001-editions-
// setup-and-accounts.md, section 2.9; src/installation-binding/).
//
// `installation_link_requests`: a person asked to link an installation, and the role of their GitHub account in
// the installation's organization could not be read with their token, so nothing was linked and the instance
// admin decides. The row keeps the evidence the approval page shows (whether the person's token could access
// the installation, and the result of the role read), never the token. At most one request per (workspace,
// installation) is pending at a time. A row goes with its workspace; the requester and the decider are kept
// as ids only (`set null` when the user is gone).
//
// `unclaimed_installations`: installations of the GitHub App that no workspace has linked. The app-wide
// installation listing and a webhook about a new installation may only note them here: they never create a
// connection (a connection is what gives a workspace the repositories of an account).
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("installation_link_requests")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id").onDelete("cascade"),
      )
      .addColumn("requested_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      // The GitHub account the requester proved control of, as shown on the approval page.
      .addColumn("requester_github_login", "text")
      // The platform's id of the installation, as text.
      .addColumn("installation_id", "text", (column) => column.notNull())
      .addColumn("account_login", "text", (column) => column.notNull())
      .addColumn("account_type", "text", (column) => column.notNull())
      .addColumn("account_id", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      // 1 or 0: the user's token lists the installation; null when it could not be asked.
      .addColumn("token_can_access", "integer")
      // A RoleResult (src/installation-binding/github-user.ts): admin, member, unreadable or unavailable.
      .addColumn("role_result", "text", (column) => column.notNull())
      // A stable code that says why the role could not be read, or null.
      .addColumn("role_detail", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("decided_at", "text")
      .addColumn("decided_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addCheckConstraint(
        "installation_link_requests_status_check",
        sql`status in ('pending', 'approved', 'denied', 'withdrawn')`,
      )
      .execute();

    await db.schema
      .createIndex("installation_link_requests_pending_unique")
      .on("installation_link_requests")
      .columns(["workspace_id", "installation_id"])
      .unique()
      .where(sql<boolean>`status = 'pending'`)
      .execute();

    await db.schema
      .createIndex("installation_link_requests_workspace")
      .on("installation_link_requests")
      .columns(["workspace_id", "created_at"])
      .execute();

    await db.schema
      .createIndex("installation_link_requests_status")
      .on("installation_link_requests")
      .columns(["status", "created_at"])
      .execute();

    await db.schema
      .createTable("unclaimed_installations")
      .addColumn("installation_id", "text", (column) => column.primaryKey())
      .addColumn("account_login", "text", (column) => column.notNull())
      .addColumn("account_type", "text", (column) => column.notNull())
      .addColumn("first_seen_at", "text", (column) => column.notNull())
      .addColumn("last_seen_at", "text", (column) => column.notNull())
      // What noticed it: `webhook` or `sync`.
      .addColumn("source", "text", (column) => column.notNull())
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("unclaimed_installations").execute();
    await db.schema.dropTable("installation_link_requests").execute();
  },
};
