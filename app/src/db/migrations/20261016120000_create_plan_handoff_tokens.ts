// SPDX-License-Identifier: LicenseRef-Proprietary

// `plan_handoff_tokens` (#284): the single-use tokens with which an Owner or Admin is handed over to the
// operator-configured plan page (src/plan-handoff/README.md). The token is 256 random bits and travels in the
// redirect only; the table keeps its SHA-256 hash (`token_hash`), so a copy of the database cannot be redeemed. A
// token is bound to the workspace, the person and the role they had when it was made, expires after 5 minutes
// (`expires_at`), is used once (`used_at`) and is revoked (`revoked_at`) by a newer token of the same person in the
// same workspace. A row goes with its user. The table is new and empty and no existing row is touched, so an app of
// the previous release (which never reads it) keeps working on the same database.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("plan_handoff_tokens")
      .addColumn("token_hash", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("user_id", "text", (column) =>
        column.notNull().references("users.id").onDelete("cascade"),
      )
      .addColumn("role", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("used_at", "text")
      .addColumn("revoked_at", "text")
      .addCheckConstraint(
        "plan_handoff_tokens_role_check",
        sql`role in ('owner', 'admin')`,
      )
      .execute();

    // "Which unused tokens does this person have in this workspace?" (a new token revokes them).
    await db.schema
      .createIndex("plan_handoff_tokens_person")
      .on("plan_handoff_tokens")
      .columns(["workspace_id", "user_id"])
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("plan_handoff_tokens").execute();
  },
};
