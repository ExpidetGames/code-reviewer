// SPDX-License-Identifier: LicenseRef-Proprietary

// The holds that nobody released (#591; src/billing/README.md): a `reservation` of a job that has ended, whose settlement
// nothing is going to write, and that has no `release`. Billing writes the release in the transaction that ends the job, so
// this is only what a job that ended while billing was off, or a damaged database, leaves behind. Instance level on
// purpose, like the other sweeps: it looks at every workspace, only reads, and every answer names its workspace; the release
// itself goes through the journal repository of that workspace (src/billing/stranded-holds.ts).
//
// "Nothing is going to write": a job whose usage record is still `reserved` is not stranded. Every job that ends closes its
// record in the transaction that ends it (src/db/repositories/usage-records-sweep.ts) and settles its hold there; the one
// record that stays `reserved` after its job ended is a superseded run whose Worker still drains (#397), and its hold is
// settled when the Worker reports or when the drain and the grace run out. Releasing it earlier would lose the charge.
//
// The work grows with the holds that are open, never with the history, in two steps:
//  1. The workspaces that have something stranded, by comparing two numbers that are both small to read: what the balance
//     row says is reserved, and the holds that belong to a `reserved` record (the partial index of the records that are
//     reserved, then the unique key of the journal). A workspace whose reserved money is all accounted for by those is done,
//     and that is every workspace in steady state: no scan of the journal, of the jobs or of the balances (the partial index
//     of the balances that hold something).
//  2. Only for those workspaces, their open reservations of ended jobs. This reads the reservations of the workspace, which
//     is why it is only done for a workspace that has a hold to release; the release ends it. (A workspace whose cache says
//     more is reserved than its holds explain, because a job row is gone or the cache is damaged, is looked at in every run;
//     `verify()` shows that workspace.)
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

/**
 * Step 1: the workspaces whose reserved money is more than the holds that belong to a `reserved` record explain. Literals, not
 * bound values, where a partial index has to match (`state = 'reserved'`, `reserved_micro_usd > 0`).
 */
export function suspectWorkspacesQuery() {
  return sql<{ workspace_id: string }>`
    select b.workspace_id as workspace_id
    from billing_balances as b
    left join (
      select u.workspace_id as workspace_id, sum(-r.amount_micro_usd) as held
      from usage_records as u
      join billing_journal_entries as r
        on r.workspace_id = u.workspace_id
          and r.type = 'reservation'
          and r.ref_key = u.job_id
      where u.state = 'reserved'
        and not exists (
          select 1 from billing_journal_entries as l
          where l.workspace_id = r.workspace_id
            and l.type = 'release'
            and l.ref_key = r.ref_key
        )
      group by u.workspace_id
    ) as accounted on accounted.workspace_id = b.workspace_id
    where b.reserved_micro_usd > 0
      and b.reserved_micro_usd > coalesce(accounted.held, 0)
    order by b.workspace_id`;
}

/** At most `limit` stranded holds, in a fixed order (workspace, then job), so a repeated run walks the same way. */
export async function findStrandedHolds(
  db: Kysely<Database>,
  limit: number,
): Promise<StrandedHold[]> {
  const { rows: suspects } = await suspectWorkspacesQuery().execute(db);
  if (suspects.length === 0) return [];
  // The workspaces are named on both sides of the anti join (the second `in` repeats the first on purpose): the planner then
  // reads the releases of these workspaces by their index, not all of them.
  const named = sql.join(suspects.map((row) => row.workspace_id));
  const { rows } = await sql<{ workspace_id: string; job_id: string }>`
    select r.workspace_id as workspace_id, r.ref_key as job_id
    from billing_journal_entries as r
    left join billing_journal_entries as l
      on l.workspace_id = r.workspace_id
        and l.type = 'release'
        and l.ref_key = r.ref_key
        and l.workspace_id in (${named})
    join jobs as j on j.id = r.ref_key and j.workspace_id = r.workspace_id
    where r.workspace_id in (${named})
      and r.type = 'reservation'
      and l.id is null
      and j.status in (${sql.join([...ENDED_JOB_STATUSES])})
      and not exists (
        select 1 from usage_records as u
        where u.job_id = j.id and u.state = 'reserved'
      )
    order by r.workspace_id, r.ref_key
    limit ${limit}`.execute(db);
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    jobId: row.job_id,
  }));
}
