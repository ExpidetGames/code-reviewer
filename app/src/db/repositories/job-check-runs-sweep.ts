// SPDX-License-Identifier: Apache-2.0

// The jobs whose check run on the platform is behind, for the reconciler that serves the whole instance (#405).
// Instance level on purpose, like the sweep of the refusal notices: it reads the rows of every workspace, only the
// ones that are due, and every answer names its workspace; whatever is done next goes through the scoped repository
// (job-check-runs-repository.ts).
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type JobWithCheckWork = { jobId: string; workspaceId: string };

/**
 * Jobs that need a sync, oldest change first, at most `limit`:
 * - a waiting or running job that has no row yet (its first sync never started or never finished);
 * - a job with an `active` row whose lease or back-off is over and that is behind: the check run (unless it was
 *   dropped) shows another status than the job has now (a lease that ran out, a timeout, a give-up or a switch-off ended it without a
 *   request of its own), or the job succeeded and its verdict is not decided yet.
 * A job that ended before it had a row (for example before this feature) is not listed: nothing was ever shown.
 */
export async function listJobsWithCheckWork(
  db: Kysely<Database>,
  now: Date,
  options: { limit: number },
): Promise<JobWithCheckWork[]> {
  const timestamp = formatTimestamp(now);
  const rows = await db
    .selectFrom("jobs")
    .leftJoin("job_check_runs", "job_check_runs.job_id", "jobs.id")
    .select(["jobs.id as jobId", "jobs.workspace_id as workspaceId"])
    .where((eb) =>
      eb.or([
        eb.and([
          eb("job_check_runs.job_id", "is", null),
          eb("jobs.status", "in", ["queued", "running"]),
        ]),
        eb.and([
          eb("job_check_runs.state", "=", "active"),
          eb("job_check_runs.next_attempt_at", "<=", timestamp),
          eb.or([
            eb.and([
              eb("job_check_runs.check_state", "=", "active"),
              eb.or([
                eb("job_check_runs.synced_status", "is", null),
                eb("job_check_runs.synced_status", "<>", eb.ref("jobs.status")),
              ]),
            ]),
            eb.and([
              eb("jobs.status", "=", "succeeded"),
              eb("job_check_runs.review_state", "=", "pending"),
            ]),
          ]),
        ]),
      ]),
    )
    .orderBy("jobs.updated_at")
    .orderBy("jobs.id")
    .limit(options.limit)
    .execute();
  return rows;
}
