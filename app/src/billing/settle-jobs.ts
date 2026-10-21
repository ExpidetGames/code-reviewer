// SPDX-License-Identifier: Apache-2.0

// The settlement of a job's hold (ADR 0006, 2.6 and 2.8; #498). Called from the transaction that ENDS jobs, with the ids of
// the jobs whose usage record just reached its end: it prices each run (`classifyOutcome`, `priceRun`, the minutes of
// #493) and writes, in that transaction, a `release` of the hold and, unless the run is free, a `usage` entry. A job that
// never took a hold (billing was off at its claim, or its hold was zero) is left alone, and so is one whose hold is released
// already, so a repeated completion, a sweep after it and a requeue change nothing.
//
// Billing off: nothing here runs. The only thing read is the switch, which is an instance setting, never a billing table.
//
// A run that cannot be priced (damaged data: a rate, a cost) releases its hold and charges nothing, with a log line of its
// stable code and the job id: a customer is never charged a number nobody could compute, and money is never left held.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import { tryDecodeJson } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { KeyMode } from "../workspaces/entitlements.ts";
import { readClaimBilling } from "./claim-billing.ts";
import { classifyOutcome, type RunEnd } from "./outcome.ts";
import { PricingError, priceRun } from "./pricing.ts";

type EndedStatus = RunEnd["status"];
const ENDED_STATUSES: readonly string[] = [
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
];

/** The stable codes of the log lines of this module. */
export const SETTLE_LOG_CODES = [
  "BILLING_PRICING_FAILED",
  "BILLING_RATES_INCOMPLETE_AT_SETTLEMENT",
] as const;

function errorReasonOf(resultText: string | null): string | null {
  if (resultText === null) return null;
  const decoded = tryDecodeJson(resultText);
  if (!decoded.ok) return null;
  const result = decoded.value;
  if (typeof result !== "object" || result === null) return null;
  const reason = (result as { errorReason?: unknown }).errorReason;
  return typeof reason === "string" ? reason : null;
}

/**
 * The started minutes of a job that ends charged. A run with a VM of its final claim measures it (#493). A run of that claim
 * with none is never priced at 0 minutes silently (the gate of the review of #524): it ran, so its claim to its end is the
 * measure, flagged `claim_wall_clock` when a Dispatcher acknowledged the job (a VM was started and its report was lost, or the
 * Dispatcher is of an earlier release) and `job_wall_clock` for a runner with no VM at all. A job that was given back (it has
 * no claim) measures 0.
 */
async function minutesOf(
  trx: Kysely<Database>,
  workspaceId: string,
  jobId: string,
  now: () => Date,
): Promise<number> {
  const runs = createJobVmRunsRepository(trx, workspaceId, now);
  let measured = await runs.measure(jobId);
  if (measured.state === "measured" && measured.run === null) {
    const hosted =
      (await createJobDispatchesRepository(trx, now).get(jobId))?.ackedAt !=
      null;
    const recorded = await runs.recordWallClock(
      jobId,
      hosted ? "claim_wall_clock" : "job_wall_clock",
    );
    if (recorded !== "not_measurable") measured = await runs.measure(jobId);
  }
  return measured.state === "measured" ? measured.minutes : 0;
}

/**
 * Settles the holds of these jobs, which ended in the transaction `trx`. Jobs of any workspace; each is looked at under its
 * own workspace. Never throws for a job that is not billed.
 */
export async function settleEndedJobs(
  trx: Kysely<Database>,
  jobIds: readonly string[],
  now: () => Date,
): Promise<void> {
  if (jobIds.length === 0) return;
  const billing = await readClaimBilling(trx);
  if (billing.state === "off") return;
  const jobs = await trx
    .selectFrom("jobs")
    .select([
      "id",
      "workspace_id",
      "status",
      "error_code",
      "result",
      "review_kind",
    ])
    .where("id", "in", [...new Set(jobIds)])
    .orderBy("id")
    .execute();
  for (const job of jobs) {
    if (!ENDED_STATUSES.includes(job.status)) continue;
    const journal = createBillingJournalRepository(trx, job.workspace_id, now);
    if ((await journal.findByKey("reservation", job.id)) === undefined)
      continue;
    // Settled or released before: nothing changes (a repeated completion, a sweep after it).
    if ((await journal.findByKey("release", job.id)) !== undefined) continue;

    if (billing.state === "rates_incomplete") {
      // The rates were removed after the claim: the run cannot be priced, and the hold must not stay.
      console.error(`[billing] BILLING_RATES_INCOMPLETE_AT_SETTLEMENT job=${job.id}`);
      await journal.release(job.id);
      continue;
    }

    const record = await trx
      .selectFrom("usage_records")
      .select(["key_mode", "cost_micro_usd", "settled_reason"])
      .where("job_id", "=", job.id)
      .where("workspace_id", "=", job.workspace_id)
      .executeTakeFirst();
    const keyMode: KeyMode = record?.key_mode === "managed" ? "managed" : "own";
    const reviewKind = job.review_kind as ProjectReviewKind;
    const outcomeClass = classifyOutcome({
      status: job.status as EndedStatus,
      errorCode: job.error_code,
      errorReason: errorReasonOf(job.result),
      settledReason: record?.settled_reason ?? null,
      keyMode,
      aiCostKnown: record?.cost_micro_usd != null,
    });
    // A run that is free is not measured: nothing is charged whatever it measures.
    if (outcomeClass === "free") {
      await journal.release(job.id);
      continue;
    }
    const minutes = await minutesOf(trx, job.workspace_id, job.id, now);
    try {
      const price = priceRun({
        keyMode,
        outcomeClass,
        costMicroUsd: record?.cost_micro_usd ?? null,
        billableMinutes: minutes,
        reviewKind,
        rates: billing.rates,
      });
      if (price.totalMicroUsd === 0) await journal.release(job.id);
      else
        await journal.settle(job.id, {
          aiMicroUsd: price.aiMicroUsd,
          infraMicroUsd: price.infraMicroUsd,
          minutes,
          reviewKind,
        });
    } catch (error) {
      if (!(error instanceof PricingError)) throw error;
      console.error(`[billing] BILLING_PRICING_FAILED job=${job.id} code=${error.code}`);
      await journal.release(job.id);
    }
  }
}
