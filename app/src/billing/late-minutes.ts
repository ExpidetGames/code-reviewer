// SPDX-License-Identifier: Apache-2.0

// Late minutes (ADR 0006, 2.8 step 5; #498). A job settles when it ends, with the best end of its VM that the App knows then
// (the confirmed stop, else the bounded backstop of #493). The answer to the App's stop call can arrive afterwards and
// replace the backstop with the real end. If that happens within a day of the settlement and moves the started minutes by more
// than one (the ends differ by more than a minute), the journal gets ONE `correction` for the difference at the rate the run
// was charged at; otherwise the settlement stands. A job that was not billed, and billing off, change nothing.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import type { Database } from "../db/schema.ts";
import { readClaimBilling } from "./claim-billing.ts";

/** How long after the settlement the real end of a VM may still correct it. */
export const LATE_MINUTES_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The minutes must move by more than this to be worth a correction (the ends differ by more than a minute). */
export const LATE_MINUTES_TOLERANCE = 1;

export const LATE_MINUTES_RESULTS = [
  "corrected",
  "already_corrected",
  "within_tolerance",
  "too_late",
  "not_billed",
  "billing_off",
] as const;
export type LateMinutesResult = (typeof LATE_MINUTES_RESULTS)[number];

export function lateMinutesKey(jobId: string): string {
  return `late-minutes:${jobId}`;
}

export async function correctLateMinutes(
  db: Kysely<Database>,
  workspaceId: string,
  jobId: string,
  now: () => Date,
): Promise<LateMinutesResult> {
  if ((await readClaimBilling(db)).state === "off") return "billing_off";
  const journal = createBillingJournalRepository(db, workspaceId, now);
  const usage = await journal.findByKey("usage", jobId);
  // No usage entry: the run was free or never billed, and a free run has nothing to correct.
  if (usage === undefined) return "not_billed";
  if (now().getTime() - Date.parse(usage.createdAt) > LATE_MINUTES_WINDOW_MS)
    return "too_late";
  if (
    (await journal.findByKey("correction", lateMinutesKey(jobId))) !== undefined
  )
    return "already_corrected";

  const measured = await createJobVmRunsRepository(
    db,
    workspaceId,
    now,
  ).measure(jobId);
  const settledMinutes = usage.minutes ?? 0;
  const infra = usage.infraMicroUsd ?? 0;
  if (measured.state !== "measured" || settledMinutes === 0 || infra === 0)
    return "within_tolerance";
  if (Math.abs(measured.minutes - settledMinutes) <= LATE_MINUTES_TOLERANCE)
    return "within_tolerance";
  // The infrastructure part is whole started minutes times a whole rate: the rate it was charged at is exact.
  const rate = infra / settledMinutes;
  if (!Number.isSafeInteger(rate)) return "within_tolerance";
  const amount = -(measured.minutes - settledMinutes) * rate;
  await journal.append({
    type: "correction",
    amountMicroUsd: amount,
    jobId,
    refKey: lateMinutesKey(jobId),
    ...(usage.reviewKind === null ? {} : { reviewKind: usage.reviewKind }),
    minutes: measured.minutes,
    note: "late end of the VM",
  });
  return "corrected";
}
