// SPDX-License-Identifier: LicenseRef-Proprietary

// `job_vm_runs` (#493): where the infrastructure of a review job began and ended, one row per VM (or, where no VM exists,
// one row for the job's wall clock). It only measures: it sets no price and writes no journal entry (src/billing/README.md,
// "Billable minutes"). The primary key is (job_id, vm_name): the first report of a VM wins, a repeat changes nothing.
// `claimed_at` is the claim of the job the VM was started for (jobs.claimed_at at that moment): a job that is claimed
// again after a lost attempt has a new one, so the VM of the claim that produced the final outcome is the one that
// counts (`billable`), and the VMs of lost attempts, which are our fault, are kept for audit and never billed.
// `ended_at` and `end_source` are both null until a teardown is known; `billable_minutes` is `ceil(seconds / 60)` of
// the span once the end is known (src/billing/minutes.ts). Timestamps are ISO 8601 text in UTC.
//
// The table is new and empty, and no existing row is touched, so an app of the previous release (which never reads it)
// keeps working on the same database. The checks restate what the repository keeps true; the list of sources is
// `VM_END_SOURCES` in the code.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("job_vm_runs")
      .addColumn("job_id", "text", (column) =>
        column.notNull().references("jobs.id"),
      )
      .addColumn("vm_name", "text", (column) => column.notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("attempt", "integer", (column) => column.notNull())
      .addColumn("claimed_at", "text", (column) => column.notNull())
      .addColumn("started_at", "text", (column) => column.notNull())
      .addColumn("reported_at", "text", (column) => column.notNull())
      .addColumn("vm_timeout_seconds", "integer")
      .addColumn("ended_at", "text")
      .addColumn("end_source", "text")
      .addColumn("billable", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("billable_minutes", "integer")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("job_vm_runs_pk", ["job_id", "vm_name"])
      .addCheckConstraint(
        "job_vm_runs_end_source_check",
        sql`end_source is null or end_source in ('app_stop_confirmed', 'timeout_backstop', 'job_wall_clock')`,
      )
      .addCheckConstraint(
        "job_vm_runs_end_pair_check",
        sql`(ended_at is null) = (end_source is null)`,
      )
      .addCheckConstraint("job_vm_runs_billable_check", sql`billable in (0, 1)`)
      .addCheckConstraint(
        "job_vm_runs_numbers_check",
        sql`attempt >= 1 and (vm_timeout_seconds is null or vm_timeout_seconds >= 1) and (billable_minutes is null or billable_minutes >= 0)`,
      )
      .execute();

    await db.schema
      .createIndex("job_vm_runs_workspace_job")
      .on("job_vm_runs")
      .columns(["workspace_id", "job_id"])
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("job_vm_runs").execute();
  },
};
