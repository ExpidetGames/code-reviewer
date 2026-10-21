// SPDX-License-Identifier: Apache-2.0

// #498 (the gate of the review of #524): a hosted job must never measure 0 minutes silently. Two more ways an end is learned,
// both flagged in `job_vm_runs.end_source` so an audit can tell them from a measured VM: `app_stop_unreported` (the answer
// to the App's stop call named a VM nobody had reported; the row is made then, from the claim to the stop) and
// `claim_wall_clock` (a hosted job that ran has no VM row at all; its claim to its end is the measure). The list is
// `VM_END_SOURCES` in the code.
//
// Postgres replaces the constraint. SQLite cannot change a check in place, so the table is rebuilt: a new one with the wider
// check gets every row, the old one is dropped (with its index) and the new one takes its name and index back. Nothing
// references `job_vm_runs`. Safe next to a previous release: no column changes and every row survives; an older app instance
// reads a row of a new source as a source it does not know and never writes one.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { databaseDriver } from "../driver.ts";

const OLD_SOURCES = "'app_stop_confirmed', 'timeout_backstop', 'job_wall_clock'";
const NEW_SOURCES = `${OLD_SOURCES}, 'app_stop_unreported', 'claim_wall_clock'`;

type Db = Parameters<Migration["up"]>[0];

async function rebuild(db: Db, sources: string) {
  await db.schema
    .createTable("job_vm_runs_next")
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
      sql.raw(`end_source is null or end_source in (${sources})`),
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
  await sql`insert into job_vm_runs_next (job_id, vm_name, workspace_id, attempt, claimed_at, started_at, reported_at, vm_timeout_seconds, ended_at, end_source, billable, billable_minutes, created_at, updated_at)
    select job_id, vm_name, workspace_id, attempt, claimed_at, started_at, reported_at, vm_timeout_seconds, ended_at, end_source, billable, billable_minutes, created_at, updated_at from job_vm_runs`.execute(
    db,
  );
  await db.schema.dropTable("job_vm_runs").execute();
  await db.schema
    .alterTable("job_vm_runs_next")
    .renameTo("job_vm_runs")
    .execute();
  await db.schema
    .createIndex("job_vm_runs_workspace_job")
    .on("job_vm_runs")
    .columns(["workspace_id", "job_id"])
    .execute();
}

async function replaceConstraint(db: Db, sources: string) {
  await sql`alter table job_vm_runs drop constraint job_vm_runs_end_source_check`.execute(
    db,
  );
  await sql
    .raw(
      `alter table job_vm_runs add constraint job_vm_runs_end_source_check check (end_source is null or end_source in (${sources}))`,
    )
    .execute(db);
}

export const migration: Migration = {
  async up(db) {
    if (databaseDriver(db) === "postgres")
      return replaceConstraint(db, NEW_SOURCES);
    await rebuild(db, NEW_SOURCES);
  },

  async down(db) {
    // A row of a new source has no place in the narrower check; it was a measure of the same minutes, so it is kept as the
    // closest source that was there before.
    await sql`update job_vm_runs set end_source = 'timeout_backstop' where end_source = 'app_stop_unreported'`.execute(
      db,
    );
    await sql`update job_vm_runs set end_source = 'job_wall_clock' where end_source = 'claim_wall_clock'`.execute(
      db,
    );
    if (databaseDriver(db) === "postgres")
      return replaceConstraint(db, OLD_SOURCES);
    await rebuild(db, OLD_SOURCES);
  },
};
