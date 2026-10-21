// SPDX-License-Identifier: Apache-2.0

// The holds of jobs that ended while billing was off (#591; follow-up of #498). Nothing runs while billing is off, so a job
// that took its hold with billing on and ended after the switch was turned off keeps its `reservation` with no `release`: the
// money stays in `billing_balances.reserved_micro_usd` and the workspace has a reduced balance when billing is switched back on.
//
// The decision: such a run is RELEASED, not charged. Billing off means no charge, so a run that ended in that time is not
// priced as if billing had been on (it would be a charge for a period the operator had billing off, with a number nobody
// showed the customer), and money is never left held. If the maintainer prefers a charge, the change is this one function:
// hand the ids to `settleEndedJobs` (the one interpretation of the price) instead of `release`. The decision awaits their
// confirmation on #591.
//
// It runs in two places. Switching billing on calls `releaseStrandedHolds` with the transaction that writes `enabled`
// (admin-service.ts), under the lock of the billing settings, so no claim of a billing that is on ever sees a balance with a
// hold of an ended job in it. And the sweep (the cron sweep of a hosted deployment, the hourly timer of a server) calls
// `releaseStrandedHoldsWhileBillingOn`: a job that ended in the same moment as the switch-on is not seen by the transaction
// that wrote it. Both are idempotent and safe next to a settlement or a claim: every release goes through the journal's
// `release`, which takes the lock of the workspace's balance row first and writes the release under the key of the job, so a
// settlement racing it finds the release (and charges nothing) or has written its own (and the release finds it).
//
// What counts as stranded is decided by the finder (billing-holds-sweep.ts): an ended job, no `release`, and no usage record
// that is still `reserved`. A superseded run whose Worker drains has its job ended and its record reserved: its settlement (the
// release and the charge) is still to come, from the Worker's report or the expiry, and releasing its hold here would lose the
// charge.
//
// Lock order: a release locks the balance row of its workspace until the transaction ends, and the switch-on does up to a batch
// of them in one transaction, in the order workspace, then job. `settleEndedJobs` takes the jobs of its transaction in the same
// order, so two transactions that lock several workspaces never wait for each other's rows in opposite orders.
//
// Billing off: `releaseStrandedHoldsWhileBillingOn` reads the instance setting and nothing else.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { findStrandedHolds } from "../db/repositories/billing-holds-sweep.ts";
import type { Database } from "../db/schema.ts";
import { isBillingOn } from "./enabled.ts";

/** The stable code of the log line of this module. */
export const STRANDED_HOLDS_LOG_CODE = "BILLING_HOLDS_RELEASED";

/** How many holds one run releases at most; a longer list is finished by the next run (a switch-on, the next sweep). */
export const STRANDED_HOLDS_BATCH = 500;

export type StrandedHoldsResult = { released: number };

/**
 * Releases the holds of ended jobs that have none released, in this connection (a transaction when the caller has one: the
 * switch-on). Never charges. Returns how many holds this run released; one that a racing writer released first is not counted.
 */
export async function releaseStrandedHolds(
  db: Kysely<Database>,
  now: () => Date,
  { limit = STRANDED_HOLDS_BATCH }: { limit?: number } = {},
): Promise<StrandedHoldsResult> {
  let released = 0;
  for (const hold of await findStrandedHolds(db, limit)) {
    const result = await createBillingJournalRepository(
      db,
      hold.workspaceId,
      now,
    ).release(hold.jobId);
    if (result.ok && result.created) released += 1;
  }
  if (released > 0)
    console.info(
      `[billing] ${STRANDED_HOLDS_LOG_CODE} count=${String(released)}`,
    );
  return { released };
}

/** The sweep's step: the same while billing is on, and nothing but the switch is read while it is off. */
export async function releaseStrandedHoldsWhileBillingOn(
  db: Kysely<Database>,
  now: () => Date,
  options: { limit?: number } = {},
): Promise<StrandedHoldsResult> {
  if (!(await isBillingOn(db))) return { released: 0 };
  return releaseStrandedHolds(db, now, options);
}
