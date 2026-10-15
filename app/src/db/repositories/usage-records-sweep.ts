// SPDX-License-Identifier: Apache-2.0

// The sweep of usage records (src/usage/README.md) for the instance level code that ends jobs: the lease side of
// the queue (runner-jobs-repository.ts) and the switch-off of Dynamic Review (instance-settings-repository.ts).
// Instance level on purpose, like they are: it looks at the records of every workspace. The scoped twin for the
// jobs of one workspace is `voidEndedJobs()` of usage-records-repository.ts.
import "server-only";
import { sql, type Kysely } from "kysely";
import type { Database } from "../schema.ts";

/**
 * A job that ended without a report (a lost last attempt, the hard limit, a cancellation, a replacement while
 * it waited again) made no model call anybody knows of: its record, if still `reserved`, is void and no longer
 * counts (src/usage/README.md). A job that was completed already has a settled or void record, which this
 * leaves alone. One statement over the reserved records only (a partial index), run by every transition that
 * can end a job without `complete`, in the same transaction.
 */
export async function voidRecordsOfEndedJobs(
  executor: Kysely<Database>,
): Promise<void> {
  await executor
    .updateTable("usage_records")
    .set({ state: "void" })
    // A literal, not a bound value, so the planner can use the partial index of the reserved records.
    .where("state", "=", sql.lit("reserved"))
    // Driven by the few reserved records (the partial index), each probing its job by primary key: the work
    // does not grow with the history of ended jobs.
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("jobs")
          .select("jobs.id")
          .whereRef("jobs.id", "=", "usage_records.job_id")
          .where("jobs.status", "in", [
            "succeeded",
            "failed",
            "cancelled",
            "superseded",
          ]),
      ),
    )
    .execute();
}
