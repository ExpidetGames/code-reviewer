// SPDX-License-Identifier: Apache-2.0

// Billing at the claim (ADR 0006, 2.8; #498, reworked by #605): inside the claim transaction, after the admission checks, a job
// starts when the balance of its workspace is above zero and is refused otherwise. NOTHING is held: with a hold, ten dollars
// would carry three Dynamic reviews at a time. The price is charged when the job ends (settle-jobs.ts) and may take the
// balance below zero, which then refuses every claim (`balance_negative`) until the workspace tops up. Nothing here runs while
// billing is off: the only thing read is the switch itself, which lives in the instance settings, never a billing table.
//
// A job that cannot cost anything (the workspace's own key and a rate B of zero) needs no balance, only one that is not
// negative: it is charged nothing, so refusing it at a balance of exactly zero would protect nothing.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import type { Database } from "../db/schema.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { KeyMode } from "../workspaces/entitlements.ts";
import { readBillingSwitch } from "./enabled.ts";
import { BILLING_RATES_INCOMPLETE } from "./rates.ts";
import type { BillingRates } from "./rates.ts";

/** What the claim has to do about billing for the jobs it hands out. */
export type ClaimBilling =
  | { state: "off" }
  /** Billing is on and a rate is missing: no job is handed out, none can be priced. */
  | { state: "rates_incomplete" }
  | {
      state: "on";
      rates: BillingRates;
      /** The hidden brake's number (#499): started reviews of a workspace in a rolling hour. Never shown to a customer. */
      hourlyReviewLimit: number;
    };

/**
 * Whether billing is on for the claims of this moment, and with which rates. A switch that is set but whose adapter is not
 * ready (`readBillingSwitch`: a credential or a rate gone since it was set, which the admin page does not allow but a damaged
 * database can show) is `rates_incomplete`, not off: a job does not run for free and does not hold money while
 * `isBillingOn` is false. The refusal reuses the stable code `billing_rates_incomplete` (a new job error code would widen the
 * jobs table check and the refusal notices for a state an operator has to repair anyway); the Runs page says so.
 */
export async function readClaimBilling(
  db: Kysely<Database>,
): Promise<ClaimBilling> {
  const { enabled, missing, rates, hourlyReviewLimit } =
    await readBillingSwitch(db);
  if (!enabled) return { state: "off" };
  if (missing.length > 0 || rates === null)
    return { state: "rates_incomplete" };
  return { state: "on", rates, hourlyReviewLimit };
}

/** The codes a claim is refused with because of billing; each is a `JobErrorCode`. */
export const CLAIM_BILLING_REFUSALS = [
  "insufficient_balance",
  "balance_negative",
  "billing_rates_incomplete",
] as const;
export type ClaimBillingRefusal = (typeof CLAIM_BILLING_REFUSALS)[number];

export type AdmitOutcome =
  { ok: true } | { ok: false; code: ClaimBillingRefusal };

export const RATES_INCOMPLETE_REFUSAL: AdmitOutcome = {
  ok: false,
  code: BILLING_RATES_INCOMPLETE,
};

/** Whether a run of this kind on this key can be charged anything at all under these rates. */
export function canCostAnything(input: {
  keyMode: KeyMode;
  reviewKind: ProjectReviewKind;
  rates: BillingRates;
}): boolean {
  return (
    input.keyMode === "managed" ||
    input.rates.minuteRateMicroUsd[input.reviewKind] > 0
  );
}

/**
 * Whether the workspace of a job may start it, in the claim's transaction: a balance above zero, or (for a job that cannot
 * cost anything) one that is not negative. Writes nothing and holds nothing; a balance that falls to zero or below while
 * jobs run only refuses the claims that follow, and many jobs may start on a small balance at the same moment (accepted,
 * #605; the hourly brake of #499 still limits how many start).
 */
export async function admitAtClaim(
  trx: Kysely<Database>,
  input: {
    rates: BillingRates;
    job: { workspaceId: string; reviewKind: ProjectReviewKind };
    keyMode: KeyMode;
    now: () => Date;
  },
): Promise<AdmitOutcome> {
  const { balanceMicroUsd } = await createBillingJournalRepository(
    trx,
    input.job.workspaceId,
    input.now,
  ).balance();
  if (balanceMicroUsd < 0) return { ok: false, code: "balance_negative" };
  if (balanceMicroUsd > 0) return { ok: true };
  return canCostAnything({
    keyMode: input.keyMode,
    reviewKind: input.job.reviewKind,
    rates: input.rates,
  })
    ? { ok: false, code: "insufficient_balance" }
    : { ok: true };
}
