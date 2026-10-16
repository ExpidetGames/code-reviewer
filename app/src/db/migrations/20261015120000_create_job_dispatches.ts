// SPDX-License-Identifier: Apache-2.0

// `job_dispatches` (#326): where the signed wake-up call for a job stands, one row per job. It exists only
// while the instance runs with `RUNNER_DISPATCH=webhook` (src/dispatch/README.md); in the default poll mode
// nothing writes it. A row is made after the enqueue commits, `next_dispatch_at` says when the job is to be
// sent (again), and the answer of the Dispatcher moves `state`: `pending` (to be sent), `acked` (202; looked
// at again after the acknowledgement timeout, because a job that is still queued then needs another call)
// or `stopped` (the Dispatcher cannot run that kind). The table is new and empty, and no existing row is
// touched, so an app of the previous release (which never reads it) keeps working on the same database.
//
// The checks restate what the repository keeps true; the list of states is `DISPATCH_STATES` in the code.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("job_dispatches")
      .addColumn("job_id", "text", (column) =>
        column.primaryKey().notNull().references("jobs.id"),
      )
      .addColumn("state", "text", (column) =>
        column.notNull().defaultTo("pending"),
      )
      .addColumn("attempts", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("consecutive_failures", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("next_dispatch_at", "text", (column) => column.notNull())
      .addColumn("acked_at", "text")
      .addColumn("last_attempt_at", "text")
      .addColumn("last_status", "integer")
      .addColumn("last_code", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "job_dispatches_state_check",
        sql`state in ('pending', 'acked', 'stopped')`,
      )
      .addCheckConstraint(
        "job_dispatches_counts_check",
        sql`attempts >= 0 and consecutive_failures >= 0`,
      )
      .execute();

    // The sweep looks for the rows that are due; a stopped row never is.
    await db.schema
      .createIndex("job_dispatches_due")
      .on("job_dispatches")
      .column("next_dispatch_at")
      .where(sql.ref("state"), "<>", "stopped")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("job_dispatches").execute();
  },
};
