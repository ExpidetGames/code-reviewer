// SPDX-License-Identifier: Apache-2.0

// `job_check_runs` (#405): where the check run and the review verdict of a review job stand on GitHub, one row per
// job (src/check-runs/README.md). `check_run_id` and `review_id` are what makes the work idempotent: the check run
// is changed in place, the review is submitted once. `synced_status` is the job status the check run shows now, so
// the reconciler finds the jobs whose check run is behind (a job that ended without a request of its own, like a
// lease that ran out). `state` is `active` (work may be due; `next_attempt_at` is the lease of a running sync and the
// back-off of a failed one), `settled` (the job ended and everything is on GitHub) or `dropped` (nothing more will
// be done: the App lacks the permission, or the retries are used up; `last_code` says why). `review_state` is where
// the verdict stands: `pending`, `done` (submitted, or decided not to) or `dropped` (GitHub refused it).
// `check_state` is the same for the check run alone: `dropped` when the App lacks the Checks permission (the review
// verdict, which needs another permission, goes on). `check_create_attempts` and `review_submit_attempts` are counted BEFORE the call, so a later attempt knows that an
// earlier one may have made the check run or the review without its id being kept, and looks for it first.
//
// The table is new and empty, and no existing row is touched, so an app of the previous release (which never reads
// it) keeps working on the same database. The checks restate what the repository keeps true; the lists are
// `JOB_CHECK_STATES` and `REVIEW_VERDICT_STATES` in the code.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("job_check_runs")
      .addColumn("job_id", "text", (column) =>
        column.primaryKey().notNull().references("jobs.id"),
      )
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("check_run_id", "text")
      .addColumn("review_id", "text")
      .addColumn("synced_status", "text")
      .addColumn("check_create_attempts", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("review_submit_attempts", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("check_state", "text", (column) =>
        column.notNull().defaultTo("active"),
      )
      .addColumn("review_state", "text", (column) =>
        column.notNull().defaultTo("pending"),
      )
      .addColumn("state", "text", (column) =>
        column.notNull().defaultTo("active"),
      )
      .addColumn("attempts", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("next_attempt_at", "text", (column) => column.notNull())
      .addColumn("last_code", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "job_check_runs_state_check",
        sql`state in ('active', 'settled', 'dropped')`,
      )
      .addCheckConstraint(
        "job_check_runs_check_state_check",
        sql`check_state in ('active', 'dropped')`,
      )
      .addCheckConstraint(
        "job_check_runs_review_state_check",
        sql`review_state in ('pending', 'done', 'dropped')`,
      )
      .addCheckConstraint(
        "job_check_runs_counts_check",
        sql`attempts >= 0 and check_create_attempts >= 0 and review_submit_attempts >= 0`,
      )
      .execute();

    // The reconciler looks for the rows whose work is due; a settled or dropped row never is.
    await db.schema
      .createIndex("job_check_runs_due")
      .on("job_check_runs")
      .column("next_attempt_at")
      .where(sql.ref("state"), "=", "active")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("job_check_runs").execute();
  },
};
