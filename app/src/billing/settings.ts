// SPDX-License-Identifier: LicenseRef-Proprietary

// The instance setting `billing_settings` (ADR 0006): the switch and the rates (src/billing/rates.ts). Pure: no database.
// Read leniently: a stored value of an older shape (it also carried an environment, a client token and grace days) has
// the fields it no longer has ignored, and a rate that is damaged reads as not set. Written only through the rates
// service (`rates-service.ts`) and, for the switch, the admin form (#504).
import "server-only";
import { isAdapterId } from "./adapter.ts";
import { readLegalUrls, type LegalUrls } from "./legal-urls.ts";
import {
  isDiffAiReserve,
  isFactorA,
  isHourlyReviewLimit,
  isLowBalance,
  isMinuteRate,
  isRecord,
  isStartCredit,
  type StoredBillingRates,
} from "./rates.ts";
import type { StripeEnvironment } from "./stripe-client.ts";

/** The adapter a setting that names none runs on: the one that needs nothing. */
export const DEFAULT_ADAPTER_ID = "manual";

/** What the admin page records about the Stripe account (#504); nothing in it is a secret. */
export type StoredStripeState = {
  /** When a connection check last passed. A new API key or webhook secret clears it. */
  checkedAt?: string;
  /** The environment the passing check was made for (from the prefix of the key). */
  checkedEnvironment?: StripeEnvironment;
  /** The id of the webhook endpoint this app created at Stripe, to find it again. */
  webhookEndpointId?: string;
};

export type BillingSettings = StoredBillingRates & {
  /** The switch. Billing is on when this is exactly `true` and the adapter is ready (`isBillingOn`). */
  enabled: boolean;
  /** The adapter in use (`stripe` or `manual` today); not stored means `manual`. */
  adapter?: string;
  stripe?: StoredStripeState;
  /** The links to the operator's terms and privacy statement (#626); the terms link is needed to run Stripe. */
  legal?: LegalUrls;
};

/** Billing never configured: off, no rate set. */
export const DEFAULT_BILLING_SETTINGS: BillingSettings = { enabled: false };

function readRates(stored: Record<string, unknown>): StoredBillingRates {
  const rates: StoredBillingRates = {};
  if (isFactorA(stored.factorA)) rates.factorA = stored.factorA;
  if (isRecord(stored.minuteRateMicroUsd)) {
    const { diff, dynamic } = stored.minuteRateMicroUsd;
    const perKind: NonNullable<StoredBillingRates["minuteRateMicroUsd"]> = {};
    if (isMinuteRate(diff)) perKind.diff = diff;
    if (isMinuteRate(dynamic)) perKind.dynamic = dynamic;
    if (Object.keys(perKind).length > 0) rates.minuteRateMicroUsd = perKind;
  }
  if (isDiffAiReserve(stored.diffAiReserveMicroUsd))
    rates.diffAiReserveMicroUsd = stored.diffAiReserveMicroUsd;
  if (isStartCredit(stored.startCreditMicroUsd))
    rates.startCreditMicroUsd = stored.startCreditMicroUsd;
  if (isLowBalance(stored.lowBalanceMicroUsd))
    rates.lowBalanceMicroUsd = stored.lowBalanceMicroUsd;
  if (isHourlyReviewLimit(stored.hourlyReviewLimit))
    rates.hourlyReviewLimit = stored.hourlyReviewLimit;
  return rates;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const STRIPE_ID = /^[A-Za-z0-9_]{1,255}$/;

function readStripeState(stored: unknown): StoredStripeState | undefined {
  if (!isRecord(stored)) return undefined;
  const state: StoredStripeState = {};
  const { checkedAt, checkedEnvironment, webhookEndpointId } = stored;
  // A check without its environment, or the reverse, is not a check we can vouch for.
  if (
    typeof checkedAt === "string" &&
    ISO_TIMESTAMP.test(checkedAt) &&
    (checkedEnvironment === "test" || checkedEnvironment === "live")
  ) {
    state.checkedAt = checkedAt;
    state.checkedEnvironment = checkedEnvironment;
  }
  if (
    typeof webhookEndpointId === "string" &&
    STRIPE_ID.test(webhookEndpointId)
  )
    state.webhookEndpointId = webhookEndpointId;
  return Object.keys(state).length === 0 ? undefined : state;
}

/**
 * The stored value as settings. `enabled` is only true when it is exactly `true`: a setting that cannot be read, or
 * that says `"true"`, never switches billing on. A rate that is damaged (a string, a float, out of bounds) is left out,
 * which reads as not set.
 */
export function readBillingSettings(stored: unknown): BillingSettings {
  if (!isRecord(stored)) return DEFAULT_BILLING_SETTINGS;
  const stripe = readStripeState(stored.stripe);
  const legal = readLegalUrls(stored.legal);
  return {
    enabled: stored.enabled === true,
    ...(isAdapterId(stored.adapter) ? { adapter: stored.adapter } : {}),
    ...readRates(stored),
    ...(stripe === undefined ? {} : { stripe }),
    ...(legal === undefined ? {} : { legal }),
  };
}
