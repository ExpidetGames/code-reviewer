// SPDX-License-Identifier: LicenseRef-Proprietary

// `invitations`: the single-use links that bring a person into a workspace (docs/decisions/0001-
// editions-setup-and-accounts.md, sections 2.6 and 2.7). The token is 256 random bits and travels in the
// link only; the table keeps its SHA-256 hash (`token_hash`, unique), so a copy of the database cannot
// accept an invitation. An invitation is bound to the address it was made for (`email`, in its canonical
// form), carries the role the person gets (`role`, the same three roles as `workspace_members`), expires
// after 7 days (`expires_at`) and ends in exactly one of three ways: accepted (`accepted_at`,
// `accepted_by`), revoked (`revoked_at`) or expired. A resend replaces `token_hash` and `expires_at` of
// the same row, which is what invalidates the old link.
//
// At most one invitation per (workspace, address) can be pending at a time: a partial unique index over the
// rows that are neither accepted nor revoked. (Expiry is a matter of time and cannot be in an index: the
// code ends an expired invitation by revoking it before it makes a new one.) A row goes with its workspace.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("invitations")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id").onDelete("cascade"),
      )
      .addColumn("email", "text", (column) => column.notNull())
      .addColumn("role", "text", (column) => column.notNull())
      .addColumn("token_hash", "text", (column) => column.notNull().unique())
      .addColumn("invited_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("accepted_at", "text")
      .addColumn("accepted_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("revoked_at", "text")
      .addCheckConstraint(
        "invitations_role_check",
        // Written out because a check constraint cannot take bound values; the same list as
        // WORKSPACE_ROLES in src/workspaces/roles.ts (a test compares the two).
        sql`role in ('owner', 'admin', 'member')`,
      )
      .execute();

    // One pending invitation per address and workspace, whatever else is going on.
    await db.schema
      .createIndex("invitations_pending_unique")
      .on("invitations")
      .columns(["workspace_id", "email"])
      .unique()
      .where(sql<boolean>`accepted_at is null and revoked_at is null`)
      .execute();

    // "Which invitations are waiting for this address?" (the list after sign-in, with a mail server).
    await db.schema
      .createIndex("invitations_email")
      .on("invitations")
      .column("email")
      .execute();

    // The list of one workspace.
    await db.schema
      .createIndex("invitations_workspace")
      .on("invitations")
      .column("workspace_id")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("invitations").execute();
  },
};
