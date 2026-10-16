// SPDX-License-Identifier: Apache-2.0

// The sweep of usage records (src/usage/README.md) for the instance level code that ends jobs: the lease side of
// the queue (runner-jobs-repository.ts) and the switch-off of Dynamic Review (instance-settings-repository.ts).
// Instance level on purpose, like they are: it looks at the records of every workspace. The scoped twin for the
// jobs of one workspace is `voidEndedJobs()` of usage-records-repository.ts.
import "server-only";
import { sql, type Kysely } from "kysely";
import type { Database } from "../schema.ts";
import {
  NO_RESULT_JOB_ERROR_CODES,
  type UnknownCostSettlement,
} from "../../usage/usage-records.ts";

/** The statuses a job never leaves (src/jobs/job-status.ts). */
const ENDED_JOB_STATUSES = ["succeeded", "failed", "cancelled", "superseded"];

/**
 * Closes the `reserved` records of jobs that ended without a report of their run, in the transaction of the
 * transition that ended them (src/usage/README.md). A job that was completed already has a settled or void record,
 * which this leaves alone.
 *
 * - A job a runner held that then ended with no result (its lease ran out on the last attempt, it ran past the hard
 *   limit, its runner was shut down on the last attempt) may have used the model: its record is `settled` with an
 *   unknown cost and unknown tokens, and the reason `no_result`. Counting it is the conservative reading (#273).
 * - Any other ended job (cancelled, replaced, refused at claim, given back before the runner began, never
 *   dispatched) made no model call anybody knows of: its record is void and does not count.
 *
 * Two statements over the reserved records only (a partial index), each driven by those few records and probing
 * their job by primary key, so the work does not grow with the history of ended jobs.
 *
 * Returns the records it settled without a cost (the first statement), so the caller can raise the alert for
 * unknown costs once its transaction committed (#361).
 */
export async function closeRecordsOfEndedJobs(
  executor: Kysely<Database>,
  settledAt: string,
): Promise<UnknownCostSettlement[]> {
  const settled = await executor
    .updateTable("usage_records")
    .set({
      state: "settled",
      settled_at: settledAt,
      settled_reason: "no_result",
    })
    // A literal, not a bound value, so the planner can use the partial index of the reserved records.
    .where("state", "=", sql.lit("reserved"))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("jobs")
          .select("jobs.id")
          .whereRef("jobs.id", "=", "usage_records.job_id")
          .where("jobs.status", "=", "failed")
          .where("jobs.error_code", "in", [...NO_RESULT_JOB_ERROR_CODES]),
      ),
    )
    .returning(["workspace_id", "job_id"])
    .execute();
  await executor
    .updateTable("usage_records")
    .set({ state: "void" })
    .where("state", "=", sql.lit("reserved"))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("jobs")
          .select("jobs.id")
          .whereRef("jobs.id", "=", "usage_records.job_id")
          .where("jobs.status", "in", ENDED_JOB_STATUSES),
      ),
    )
    .execute();
  return settled.map((row) => ({
    workspaceId: row.workspace_id,
    jobId: row.job_id,
  }));
}
