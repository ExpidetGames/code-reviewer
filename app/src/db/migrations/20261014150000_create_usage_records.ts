// SPDX-License-Identifier: Apache-2.0

// `usage_records`: what each run consumed, one row per job (src/usage/README.md). It is written when a runner
// claims the job (`reserved`) and settled or voided when the job ends; limits, the usage page and the operator API
// read it. The table is new and empty, and no existing row is touched.
//
// `id` is a sequence, on purpose: it is the one table whose rows are read page by page by an outside reader (the
// cursor is `(settled_at, id)`), and the sequence is the stable tie-break. Every other identifier is text. A
// record is kept; there is no retention. The checks restate what the repository already keeps true, so a direct
// write cannot store an unknown state, key mode or kind, a settled record without its time, or a cost on a
// record that is not settled. Written out because a check cannot take bound values; the lists are the same as
// USAGE_STATES, KEY_MODES and PROJECT_REVIEW_KINDS in the code.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await db.schema
      .createTable("usage_records")
      .addColumn("id", "integer", (column) =>
        column.primaryKey().autoIncrement(),
      )
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("job_id", "text", (column) =>
        column.notNull().unique().references("jobs.id"),
      )
      .addColumn("review_kind", "text", (column) => column.notNull())
      .addColumn("key_mode", "text", (column) => column.notNull())
      .addColumn("model_tier", "text")
      .addColumn("state", "text", (column) => column.notNull())
      .addColumn("cost_micro_usd", "bigint")
      .addColumn("prompt_tokens", "bigint")
      .addColumn("completion_tokens", "bigint")
      .addColumn("reserved_at", "text", (column) => column.notNull())
      .addColumn("settled_at", "text")
      .addCheckConstraint(
        "usage_records_review_kind_check",
        sql`review_kind in ('diff', 'dynamic')`,
      )
      .addCheckConstraint(
        "usage_records_key_mode_check",
        sql`key_mode in ('own', 'managed')`,
      )
      .addCheckConstraint(
        "usage_records_state_check",
        sql`state in ('reserved', 'settled', 'void')`,
      )
      .addCheckConstraint(
        "usage_records_settled_at_check",
        sql`(state = 'settled' and settled_at is not null) or (state <> 'settled' and settled_at is null)`,
      )
      .addCheckConstraint(
        "usage_records_measured_check",
        sql`state = 'settled' or (cost_micro_usd is null and prompt_tokens is null and completion_tokens is null)`,
      )
      .addCheckConstraint(
        "usage_records_amounts_check",
        sql`(cost_micro_usd is null or cost_micro_usd >= 0) and (prompt_tokens is null or prompt_tokens >= 0) and (completion_tokens is null or completion_tokens >= 0)`,
      )
      .execute();

    // Counting runs of a kind since a time, per workspace.
    await db.schema
      .createIndex("usage_records_workspace_reserved")
      .on("usage_records")
      .columns(["workspace_id", "review_kind", "reserved_at"])
      .execute();

    // The page of settled records and the sum of settled cost, per workspace and for the whole instance.
    await db.schema
      .createIndex("usage_records_settled")
      .on("usage_records")
      .columns(["settled_at", "id"])
      .where(sql.ref("state"), "=", "settled")
      .execute();
    await db.schema
      .createIndex("usage_records_workspace_settled")
      .on("usage_records")
      .columns(["workspace_id", "settled_at"])
      .where(sql.ref("state"), "=", "settled")
      .execute();

    // The queue voids the records of jobs that ended without reporting; it only looks at reserved ones.
    await db.schema
      .createIndex("usage_records_reserved")
      .on("usage_records")
      .column("job_id")
      .where(sql.ref("state"), "=", "reserved")
      .execute();
  },

  async down(db) {
    await db.schema.dropTable("usage_records").execute();
  },
};
