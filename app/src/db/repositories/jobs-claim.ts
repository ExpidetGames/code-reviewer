// SPDX-License-Identifier: Apache-2.0

// The claim of a job: the one place in the job queue that is written for a dialect.
//
// SQLite (`claimOldestDueJob`): one `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *`, which
// SQLite runs as one atomic statement. Together with the `begin immediate` transactions of
// `dialect.ts`, which take the database's single write lock up front, two runners claiming at once
// are serialized: the second one sees the first one's row as `running` and takes the next job (or
// none).
//
// Postgres (`claimOldestDueJobPostgres`): the same statement with `FOR UPDATE SKIP LOCKED` in the
// sub-select, so two runners do not wait on each other's candidate. `SKIP LOCKED` alone is not
// enough: two queued jobs of one pull request have no running job to skip on, so both runners can
// pick one each. The partial unique index `jobs_one_running_per_pull_request_unique` (on both
// databases) is what keeps the rule; the second `UPDATE` then fails with a unique violation, which
// this code treats as "skip this job, try the next". A savepoint makes that recoverable: a Postgres
// transaction that hit an error cannot run another statement until it is rolled back to a savepoint.
// (An earlier version of this comment claimed `FOR UPDATE SKIP LOCKED` was the only line a port
// would change; it is not, and the index is the reason.)
import { sql, type Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import { errorCode } from "../errors.ts";
import type { Database, JobsTable } from "../schema.ts";

/** Everything a claim writes onto the job it hands out. */
export type JobClaim = {
  runnerId: string;
  leaseToken: string;
  now: Date;
  leaseExpiresAt: Date;
};

/** Postgres answers a unique index violation with SQLSTATE 23505. */
const UNIQUE_VIOLATION = "23505";
/** Enough for every pull request in the queue to be tried; a bug fails instead of looping. */
const MAX_CLAIM_ATTEMPTS = 100;

/**
 * Hands the oldest due job to `runnerId`, or returns undefined when there is none.
 *
 * A job is due when it is `queued` and its `run_after` has passed. A pull request with a running job
 * is skipped, so at most one job runs per pull request; the first job of another pull request goes
 * instead. Call it inside a transaction, after expired leases have been dealt with.
 */
export async function claimOldestDueJob(
  executor: Kysely<Database>,
  claim: JobClaim,
): Promise<JobsTable | undefined> {
  const { rows } = await claimQuery(executor, claim, { skipLocked: false });
  return rows[0];
}

/**
 * The Postgres claim: the statement above with `FOR UPDATE SKIP LOCKED`, and a unique violation (the
 * running slot of that pull request was taken by another runner at the same moment) makes it try the
 * next due job instead of failing the transaction. Call it inside a transaction.
 */
export async function claimOldestDueJobPostgres(
  executor: Kysely<Database>,
  claim: JobClaim,
): Promise<JobsTable | undefined> {
  // One savepoint for the whole attempt loop: a rolled-back-to savepoint stays usable, and the outer
  // transaction can keep going after each unique violation.
  await sql`savepoint claim_attempt`.execute(executor);
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    try {
      const { rows } = await claimQuery(executor, claim, { skipLocked: true });
      return rows[0];
    } catch (error) {
      if (errorCode(error) !== UNIQUE_VIOLATION) throw error;
      // The pull request of the candidate now has a running job (visible after the savepoint is
      // rolled back), so the next attempt picks another pull request, or nothing.
      await sql`rollback to savepoint claim_attempt`.execute(executor);
    }
  }
  // Every due job was contended at its own moment; the runner polls again.
  return undefined;
}

/** The one claim statement; `for update skip locked` is Postgres-only. */
function claimQuery(
  executor: Kysely<Database>,
  claim: JobClaim,
  { skipLocked }: { skipLocked: boolean },
) {
  const now = formatTimestamp(claim.now);
  return sql<JobsTable>`
    update jobs
    set status = 'running',
        runner_id = ${claim.runnerId},
        lease_token = ${claim.leaseToken},
        claimed_at = ${now},
        heartbeat_at = ${now},
        lease_expires_at = ${formatTimestamp(claim.leaseExpiresAt)},
        updated_at = ${now}
    where id = (
      select due.id
      from jobs as due
      where due.status = 'queued'
        and due.command = 'review'
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
      ${skipLocked ? sql`for update skip locked` : sql``}
    )
    returning *`.execute(executor);
}
