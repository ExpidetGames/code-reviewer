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
import { readStoredBillingSettings } from "./enabled.ts";
import { DYNAMIC_COST_LIMIT_MICRO_USD, maxVmMinutes } from "./hold.ts";
import { reserveFor } from "./pricing.ts";
import { BILLING_RATES_INCOMPLETE, billingRatesOf } from "./rates.ts";
import type { BillingRates } from "./rates.ts";
import { readBillingSettings } from "./settings.ts";

/** What the claim has to do about billing for the jobs it hands out. */
export type ClaimBilling =
  | { state: "off" }
  /** Billing is on and a rate is missing: no job is handed out, none can be priced. */
  | { state: "rates_incomplete" }
  | { state: "on"; rates: BillingRates };

/**
 * Whether billing is on for the claims of this moment, and with which rates. THE seam of #504: today the switch is
 * `billing_settings.enabled` and the rates are complete; when the admin page makes a switch that is set but no longer ready
 * (`readBillingSwitch`), that state is `rates_incomplete` here too, with no change to the claim.
 */
export async function readClaimBilling(
  db: Kysely<Database>,
): Promise<ClaimBilling> {
  const stored = await readStoredBillingSettings(db);
  if (stored === undefined) return { state: "off" };
  const settings = readBillingSettings(stored);
  if (!settings.enabled) return { state: "off" };
  const rates = billingRatesOf(settings);
  return rates === null
    ? { state: "rates_incomplete" }
    : { state: "on", rates };
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
