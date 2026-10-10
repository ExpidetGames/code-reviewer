// The claim of a job: the one place in the job queue that is written for SQLite.
//
// What makes it dialect specific:
//
// - It is a single `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *`, which SQLite runs as one
//   atomic statement. Together with the `begin immediate` transactions of `dialect.ts`, which take
//   the database's single write lock up front, two runners claiming at once are serialized: the
//   second one sees the first one's row as `running` and takes the next job (or none).
// - On Postgres the same statement needs `FOR UPDATE SKIP LOCKED` in the sub-select; that is the
//   only line a port would change.
//
// Everything else the queue does (expiring leases, enqueueing, completing) is plain query builder
// code in `jobs-repository.ts`.
import { sql, type Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, JobsTable } from "../schema.ts";

/**
 * Hands the oldest due job to `runnerId`, or returns undefined when there is none.
 *
 * A job is due when it is `queued` and its `run_after` has passed. A pull request with a running job
 * is skipped, so at most one job runs per pull request; the first job of another pull request goes
 * instead. Call it inside a transaction, after expired leases have been dealt with.
 */
export async function claimOldestDueJob(
  executor: Kysely<Database>,
  claim: { runnerId: string; now: Date; leaseExpiresAt: Date },
): Promise<JobsTable | undefined> {
  const now = formatTimestamp(claim.now);
  const leaseExpiresAt = formatTimestamp(claim.leaseExpiresAt);
  const { rows } = await sql<JobsTable>`
    update jobs
    set status = 'running',
        runner_id = ${claim.runnerId},
        claimed_at = ${now},
        heartbeat_at = ${now},
        lease_expires_at = ${leaseExpiresAt},
        updated_at = ${now}
    where id = (
      select due.id
      from jobs as due
      where due.status = 'queued'
        and due.run_after <= ${now}
        and not exists (
          select 1
          from jobs as busy
          where busy.status = 'running'
            and busy.repository_id = due.repository_id
            and busy.pr_number = due.pr_number
        )
      order by due.created_at, due.id
      limit 1
    )
    returning *`.execute(executor);
  return rows[0];
}
