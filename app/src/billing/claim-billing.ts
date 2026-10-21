// SPDX-License-Identifier: Apache-2.0

// Billing at the claim (ADR 0006, 2.8; #498): inside the claim transaction, after the admission checks, the job takes a hold
// from the balance of its workspace or is refused. Nothing here runs while billing is off: the only thing read is the
// switch itself, which lives in the instance settings, never a billing table.
//
// The hold is `reserveFor` (the longest the VM lives times B, plus on the operator's key the AI budget times A). It is at
// most the balance (decision 5 of #489: "holds reserve at most the available balance; the final charge may take the
// balance slightly negative"), so a workspace with a little credit still runs, and only an empty one is refused
// (`insufficient_balance`). A balance below zero refuses every job (`balance_negative`), also one whose hold is zero.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import type { Database } from "../db/schema.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import type { KeyMode } from "../workspaces/entitlements.ts";
import { readBillingSwitch } from "./enabled.ts";
import { DYNAMIC_COST_LIMIT_MICRO_USD, maxVmMinutes } from "./hold.ts";
import { reserveFor } from "./pricing.ts";
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
  "billing_hold_released",
] as const;
export type ClaimBillingRefusal = (typeof CLAIM_BILLING_REFUSALS)[number];

export type ReserveOutcome =
  { ok: true } | { ok: false; code: ClaimBillingRefusal };

export const RATES_INCOMPLETE_REFUSAL: ReserveOutcome = {
  ok: false,
  code: BILLING_RATES_INCOMPLETE,
};

/** The hold of a job in micro-USD: what `reserveFor` says for the key mode, the kind and the rates. */
export function holdOf(input: {
  keyMode: KeyMode;
  reviewKind: ProjectReviewKind;
  rates: BillingRates;
}): number {
  return reserveFor({
    keyMode: input.keyMode,
    reviewKind: input.reviewKind,
    maxMinutes: maxVmMinutes(input.reviewKind),
    rates: input.rates,
    dynamicCostLimitMicroUsd: DYNAMIC_COST_LIMIT_MICRO_USD,
  }).totalMicroUsd;
}

/**
 * Takes the hold of a claimed job, in the claim's transaction, or says why not. A job that was claimed before keeps the hold
 * it has. A hold of zero (the workspace's own key and B = 0) writes nothing, but a balance below zero still refuses.
 */
export async function reserveAtClaim(
  trx: Kysely<Database>,
  input: {
    rates: BillingRates;
    job: { id: string; workspaceId: string; reviewKind: ProjectReviewKind };
    keyMode: KeyMode;
    now: () => Date;
  },
): Promise<ReserveOutcome> {
  const { job } = input;
  const journal = createBillingJournalRepository(
    trx,
    job.workspaceId,
    input.now,
  );
  const hold = holdOf({
    keyMode: input.keyMode,
    reviewKind: job.reviewKind,
    rates: input.rates,
  });
  if (hold === 0) {
    const { balanceMicroUsd } = await journal.balance();
    return balanceMicroUsd < 0
      ? { ok: false, code: "balance_negative" }
      : { ok: true };
  }
  const reserved = await journal.reserveUpTo(job.id, hold);
  if (reserved.ok) return { ok: true };
  switch (reserved.code) {
    case "balance_negative":
      return { ok: false, code: "balance_negative" };
    case "reservation_released":
      return { ok: false, code: "billing_hold_released" };
    case "balance_exhausted":
    case "insufficient_balance":
      return { ok: false, code: "insufficient_balance" };
  }
}
