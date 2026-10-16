// SPDX-License-Identifier: Apache-2.0

// `refusal_notices` (#281): the record that one pull request got the notice of a refused review in one period
// (src/refusal-notices/README.md). One row per workspace, repository, pull request and period start, so a second
// push or a manual review in the same period posts nothing again, and a later period may post again. `state` is
// `pending` (to be posted; `attempts` and `next_attempt_at` bound the retries), `posted`, or `dropped` (the pull
// request was closed before the notice could be posted). The table is new and empty, and no existing row is
// touched, so an app of the previous release (which never reads it) keeps working on the same database.
//
// The checks restate what the repository keeps true; the lists are `NOTICE_STATES` and `NOTICE_CODES` in the code.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("refusal_notices")
      .addColumn("id", "text", (column) => column.primaryKey().notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("repository_id", "text", (column) =>
        column.notNull().references("repositories.id"),
      )
      .addColumn("pr_number", "integer", (column) => column.notNull())
      .addColumn("period_start", "text", (column) => column.notNull())
      .addColumn("code", "text", (column) => column.notNull())
      .addColumn("state", "text", (column) =>
        column.notNull().defaultTo("pending"),
      )
      .addColumn("attempts", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("next_attempt_at", "text", (column) => column.notNull())
      .addColumn("posted_at", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "refusal_notices_state_check",
        sql`state in ('pending', 'posted', 'dropped')`,
      )
      .addCheckConstraint(
        "refusal_notices_code_check",
        sql`code in ('quota_exhausted', 'workspace_suspended')`,
      )
      .addCheckConstraint(
        "refusal_notices_attempts_check",
        sql`attempts >= 0 and pr_number >= 1`,
      )
      .addCheckConstraint(
        "refusal_notices_posted_check",
        sql`(state = 'posted' and posted_at is not null) or (state <> 'posted' and posted_at is null)`,
      )
      .execute();

    // The dedupe: one notice per pull request and period.
    await db.schema
      .createIndex("refusal_notices_pull_request_period")
      .on("refusal_notices")
      .columns(["workspace_id", "repository_id", "pr_number", "period_start"])
      .unique()
      .execute();

    // The sweep looks for the notices that are due again; only pending ones.
    await db.schema
      .createIndex("refusal_notices_due")
      .on("refusal_notices")
      .column("next_attempt_at")
      .where(sql.ref("state"), "=", "pending")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("refusal_notices").execute();
  },
};
