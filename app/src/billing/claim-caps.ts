// SPDX-License-Identifier: LicenseRef-Proprietary

// The monthly total limit and the hidden hourly brake at the claim (ADR 0006, 2.9; D10, D12; #499). They run inside the claim
// transaction, while billing is on, after the entitlements and before the balance (`claim-billing.ts`). They act at the claim
// ONLY: a run that started is never stopped by them, so a review is never cut short for money (the cost guard of Dynamic Review
// and its final-call exemption are untouched).
//
// - The brake counts the reviews the workspace started in the last 60 minutes (usage records by `reserved_at`, every state: a
//   review that was cancelled or replaced did start) and refuses `reviews_paused` once the instance's number is reached.
//   The number is an instance setting (#504, default 60); nothing here, in a log or in a notice says what it is or how long
//   the window is.
// - The monthly limit is the customer's own, optional, null by default. A claim is refused `monthly_limit_reached` once the
//   charges of the current UTC calendar month (the `usage` entries of the journal, AI plus infrastructure, by the time the
//   run was settled) have reached the limit: `charged >= limit` (maintainer decision on #499). Nothing else counts: not the
//   holds of the runs in flight, not the hold the new job would take (the balance check of #498 is a separate matter). So a
//   job starts while the charges are below the limit even when its own cost would take the month above it, and a run that
//   started is never cut short.
//
// Exact: the claim runs under the instance gate lock, and the record of
// a started review is written in the same transaction, so two claims never both take the last start of the hour.
//
// Robust: the evaluation runs in a savepoint. Anything that goes wrong in it (a table that cannot be read, a stored value that
// is no number) is undone, logged with the workspace id and the kind of error only, and answered as the stable refusal
// `billing_limits_unreadable`: closed for that job, never open, and never thrown out of the claim, so the queue goes on with the
// next job. A refusal is free, like every refusal at the claim. A failure that may pass (a deadlock, a statement timeout, a busy
// database: `isTransientDatabaseError`) is not a verdict on the job: it is marked `transient` and the claim gives the job back to
// the queue instead (`CLAIM_CAPS_RETRY_MS`, one attempt counted, so it still ends after the attempts of a lost lease).
import "server-only";
import { sql, type Kysely } from "kysely";
import { formatTimestamp } from "../db/codecs.ts";
import { isTransientDatabaseError } from "../db/errors.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingWorkspaceSettingsRepository } from "../db/repositories/billing-workspace-settings-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import type { Database } from "../db/schema.ts";

/** The rolling window of the hourly brake. Never shown to anybody. */
const BRAKE_WINDOW_MS = 60 * 60 * 1000;

/** The codes a claim is refused with by the limits; each is a `JobErrorCode`. */
export const CLAIM_CAP_REFUSALS = [
  "reviews_paused",
  "monthly_limit_reached",
  "billing_limits_unreadable",
] as const;
export type ClaimCapRefusal = (typeof CLAIM_CAP_REFUSALS)[number];

/**
 * `transient` (only with `billing_limits_unreadable`): the evaluation failed in a way that may pass (a deadlock, a timeout, a busy
 * database; `isTransientDatabaseError`), so the claim gives the job back to the queue for a later try instead of refusing it.
 */
export type CapOutcome =
  { ok: true } | { ok: false; code: ClaimCapRefusal; transient?: true };

/** How long a job whose limits could not be read for now waits before it is due again: no hot loop, and the queue goes on past it. */
export const CLAIM_CAPS_RETRY_MS = 15_000;

/** The first moment of the UTC calendar month `now` is in, as the timestamps of the database are written. */
export function utcMonthStart(now: Date): string {
  return formatTimestamp(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  );
}

/** The moment a started review stops counting: exactly an hour before `now` is already outside the window. */
export function brakeWindowStart(now: Date): string {
  return formatTimestamp(new Date(now.getTime() - BRAKE_WINDOW_MS));
}

const SAVEPOINT = "billing_claim_caps";
export const CLAIM_CAPS_FAILED_LOG_CODE = "CLAIM_CAPS_FAILED";

function isPositiveWholeNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

async function evaluate(
  trx: Kysely<Database>,
  input: CapInput,
  current: Date,
): Promise<CapOutcome> {
  const { job } = input;
  if (!isPositiveWholeNumber(input.hourlyReviewLimit))
    throw new TypeError("the brake's number is not a positive whole number");
  const started = await createUsageRecordsRepository(
    trx,
    job.workspaceId,
    () => current,
  ).startedSince(brakeWindowStart(current), { exceptJobId: job.id });
  if (started >= input.hourlyReviewLimit)
    return { ok: false, code: "reviews_paused" };

  const limit = await createBillingWorkspaceSettingsRepository(
    trx,
    job.workspaceId,
    () => current,
  ).monthlyLimitMicroUsd();
  if (limit === null) return { ok: true };
  if (!isPositiveWholeNumber(limit))
    throw new TypeError("the monthly limit is not a positive whole number");
  const charged = await createBillingJournalRepository(
    trx,
    job.workspaceId,
    () => current,
  ).chargedSince(utcMonthStart(current));
  return charged >= limit
    ? { ok: false, code: "monthly_limit_reached" }
    : { ok: true };
}

export type CapInput = {
  /** The brake's number from the instance settings. */
  hourlyReviewLimit: number;
  job: { id: string; workspaceId: string };
  now: () => Date;
};

/**
 * Whether the claim may go on to the balance for this job: the brake first, then the monthly limit. Called with the claim's
 * transaction, only while billing is on. Never throws: see the top of the file.
 */
export async function checkClaimCaps(
  trx: Kysely<Database>,
  input: CapInput,
): Promise<CapOutcome> {
  const current = input.now();
  await sql.raw(`savepoint ${SAVEPOINT}`).execute(trx);
  try {
    const outcome = await evaluate(trx, input, current);
    await sql.raw(`release savepoint ${SAVEPOINT}`).execute(trx);
    return outcome;
  } catch (error) {
    await sql.raw(`rollback to savepoint ${SAVEPOINT}`).execute(trx);
    // The workspace and the kind of error only: no number, no amount, no message of the database.
    const transient = isTransientDatabaseError(error);
    console.warn(
      `[billing] ${CLAIM_CAPS_FAILED_LOG_CODE} workspace=${input.job.workspaceId} error=${error instanceof Error ? error.name : "unknown"} retry=${transient ? "yes" : "no"}`,
    );
    return transient
      ? { ok: false, code: "billing_limits_unreadable", transient: true }
      : { ok: false, code: "billing_limits_unreadable" };
  }
}
