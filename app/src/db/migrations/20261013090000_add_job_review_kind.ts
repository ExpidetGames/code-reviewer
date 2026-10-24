// SPDX-License-Identifier: LicenseRef-Proprietary

// #195: a job is queued for one review kind (`diff` for PR-Agent, `dynamic` for the read-only agent),
// pinned at enqueue time from the project's settings. A runner that cannot run a kind must never be
// handed the job, so the claim filters on this column.
//
// Forward-only and safe on existing data:
//
//   1. The column is added with the default `diff`, so every job that already exists — waiting,
//      running or finished — is a Diff job. The default stays on the column, so an insert that does
//      not name a kind (a migration, an old app instance writing without it) is Diff too.
//   2. The automatic-job uniqueness index gains `review_kind`: one automatic job per
//      (repository, pull request, head commit, command) **per kind**. Without the column, switching a
//      project from Diff to Dynamic (or back) would collide with the finished job of the other kind
//      and silently drop the new automatic review. The one-running-job-per-pull-request index is left
//      as it is: per-PR serialization does not depend on the kind.
//
// An added column and a recreated index both work on SQLite and Postgres (the migration runs inside
// the start's one transaction, see ../migrate.ts). The `down` drops the index and the column.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

const AUTOMATIC_PER_HEAD = "jobs_automatic_per_head_unique";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .alterTable("jobs")
      .addColumn("review_kind", "text", (column) =>
        column.notNull().defaultTo("diff"),
      )
      .execute();

    await db.schema.dropIndex(AUTOMATIC_PER_HEAD).execute();
    await db.schema
      .createIndex(AUTOMATIC_PER_HEAD)
      .on("jobs")
      .columns([
        "repository_id",
        "pr_number",
        "head_sha",
        "command",
        "review_kind",
      ])
      .unique()
      .where(
        sql<boolean>`trigger_kind = ${sql.lit("webhook")} and status in (${sql.lit("queued")}, ${sql.lit("running")}, ${sql.lit("succeeded")}, ${sql.lit("failed")})`,
      )
      .execute();
  },

  async down(db) {
    await db.schema.dropIndex(AUTOMATIC_PER_HEAD).execute();
    await db.schema
      .createIndex(AUTOMATIC_PER_HEAD)
      .on("jobs")
      .columns(["repository_id", "pr_number", "head_sha", "command"])
      .unique()
      .where(
        sql<boolean>`trigger_kind = ${sql.lit("webhook")} and status in (${sql.lit("queued")}, ${sql.lit("running")}, ${sql.lit("succeeded")}, ${sql.lit("failed")})`,
      )
      .execute();
    await db.schema.alterTable("jobs").dropColumn("review_kind").execute();
  },
};
