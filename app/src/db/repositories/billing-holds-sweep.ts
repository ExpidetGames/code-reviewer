// SPDX-License-Identifier: Apache-2.0

// The holds that nobody released (#591; src/billing/README.md): a `reservation` of a job that has ended and has no
// `release`. Billing writes the release in the transaction that ends the job, so this is only what a job that ended while
// billing was off, or a damaged database, leaves behind. Instance level on purpose, like the other sweeps: it looks at every
// workspace, only reads, and every answer names its workspace; the release itself goes through the journal repository of that
// workspace (src/billing/stranded-holds.ts).
//
// Driven by the workspaces that have something reserved (`billing_balances.reserved_micro_usd > 0`), then by their
// reservations by the unique key of the journal, so the work grows with the holds that are open, not with the history. A
// job whose row is gone is not looked at (the journal keeps opaque job ids); only a job that is there and has ended counts.
import "server-only";
import { sql, type Kysely } from "kysely";
import type { Database } from "../schema.ts";

/** The statuses a job never leaves (src/jobs/job-status.ts). */
export const ENDED_JOB_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
] as const;

export type StrandedHold = { workspaceId: string; jobId: string };

/** At most `limit` stranded holds, in a fixed order (workspace, then job), so a repeated run walks the same way. */
export async function findStrandedHolds(
  db: Kysely<Database>,
  limit: number,
): Promise<StrandedHold[]> {
  const { rows } = await sql<{ workspace_id: string; job_id: string }>`
    select r.workspace_id as workspace_id, r.ref_key as job_id
    from billing_balances as b
    join billing_journal_entries as r
      on r.workspace_id = b.workspace_id and r.type = 'reservation'
    join jobs as j
      on j.id = r.ref_key and j.workspace_id = r.workspace_id
    where b.reserved_micro_usd > 0
      and j.status in (${sql.join([...ENDED_JOB_STATUSES])})
      and not exists (
        select 1 from billing_journal_entries as l
        where l.workspace_id = r.workspace_id
          and l.type = 'release'
          and l.ref_key = r.ref_key
      )
    order by r.workspace_id, r.ref_key
    limit ${limit}`.execute(db);
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    jobId: row.job_id,
  }));
}
