// The job queue: one row per requested review (or other command) on one pull request. Rows are never
// deleted by the queue; a job that is replaced or dropped keeps its row with status `superseded` or
// `cancelled`, so the history stays readable.
//
// Three partial unique indexes carry the queue's promises even if code around them is wrong:
//
// - one job per webhook delivery id (an enqueue repeated for the same delivery finds its job);
// - one automatic job per (repository, pull request, head commit, command) while that job is waiting,
//   running or finished (a superseded or cancelled job frees the slot);
// - at most one running job per pull request.
//
// The jobs refer to `repositories`, not to projects: the check that a repository has an active
// project belongs to the code that enqueues.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("jobs")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("repository_id", "text", (column) =>
        column.notNull().references("repositories.id"),
      )
      .addColumn("pr_number", "integer", (column) => column.notNull())
      .addColumn("pr_url", "text", (column) => column.notNull())
      .addColumn("head_sha", "text", (column) => column.notNull())
      .addColumn("command", "text", (column) => column.notNull())
      .addColumn("args", "text", (column) => column.notNull())
      .addColumn("trigger_kind", "text", (column) => column.notNull())
      .addColumn("actor_login", "text", (column) => column.notNull())
      .addColumn("delivery_id", "text")
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("run_after", "text", (column) => column.notNull())
      .addColumn("attempts", "integer", (column) => column.notNull())
      .addColumn("runner_id", "text")
      .addColumn("claimed_at", "text")
      .addColumn("heartbeat_at", "text")
      .addColumn("lease_expires_at", "text")
      .addColumn("result", "text")
      .addColumn("error_code", "text")
      .addColumn("superseded_by", "text", (column) =>
        column.references("jobs.id"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("finished_at", "text")
      .execute();

    await db.schema
      .createIndex("jobs_delivery_id_unique")
      .on("jobs")
      .column("delivery_id")
      .unique()
      .where("delivery_id", "is not", null)
      .execute();

    await db.schema
      .createIndex("jobs_automatic_per_head_unique")
      .on("jobs")
      .columns(["repository_id", "pr_number", "head_sha", "command"])
      .unique()
      .where(
        sql<boolean>`trigger_kind = ${sql.lit("webhook")} and status in (${sql.lit("queued")}, ${sql.lit("running")}, ${sql.lit("succeeded")}, ${sql.lit("failed")})`,
      )
      .execute();

    await db.schema
      .createIndex("jobs_one_running_per_pull_request_unique")
      .on("jobs")
      .columns(["repository_id", "pr_number"])
      .unique()
      .where(sql.ref("status"), "=", "running")
      .execute();

    // The claim looks for waiting jobs that are due, oldest first.
    await db.schema
      .createIndex("jobs_status_run_after")
      .on("jobs")
      .columns(["status", "run_after"])
      .execute();

    // Looking up the jobs of one pull request and command (duplicate checks, supersession).
    await db.schema
      .createIndex("jobs_pull_request")
      .on("jobs")
      .columns(["repository_id", "pr_number", "command"])
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("jobs").execute();
  },
};
