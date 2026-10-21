// SPDX-License-Identifier: Apache-2.0

// What stands between an instance and a billing that can be on (ADR 0006, 2.14): the rates for every adapter (A, both B and
// the Diff AI reserve), and for Stripe also the API key, the webhook secret, a passing connection check and the link to the terms. The same list
// answers two questions: the switch (`isBillingOn`: on only when nothing is missing) and the admin page (an attempt to switch
// an incomplete setup on is refused with the items named). Pure: the caller says which credentials are stored.
import "server-only";
import type { BillingSettings } from "./settings.ts";
import { DEFAULT_ADAPTER_ID } from "./settings.ts";

/** Each item by its own stable code; the page translates them. */
export const BILLING_MISSING_ITEMS = [
  "factor_a_missing",
  "minute_rate_diff_missing",
  "minute_rate_dynamic_missing",
  "diff_ai_reserve_missing",
  "stripe_api_key_missing",
  "stripe_webhook_secret_missing",
  "connection_check_missing",
  /** The Stripe adapter shows the terms to the buyer at the first top-up (#626); the manual adapter does not need them. */
  "terms_url_missing",
] as const;
export type BillingMissingItem = (typeof BILLING_MISSING_ITEMS)[number];

/** The adapter whose readiness asks for credentials. */
export const STRIPE_ADAPTER_ID = "stripe";

export type StoredSecrets = { apiKey: boolean; webhookSecret: boolean };

export function missingItemsOf({
  settings,
  secrets,
}: {
  settings: BillingSettings;
  /** Whether each Stripe credential is stored (and, for the admin's own check, readable). */
  secrets: StoredSecrets;
}): BillingMissingItem[] {
  const missing: BillingMissingItem[] = [];
  if (settings.factorA === undefined) missing.push("factor_a_missing");
  if (settings.minuteRateMicroUsd?.diff === undefined)
    missing.push("minute_rate_diff_missing");
  if (settings.minuteRateMicroUsd?.dynamic === undefined)
    missing.push("minute_rate_dynamic_missing");
  if (settings.diffAiReserveMicroUsd === undefined)
    missing.push("diff_ai_reserve_missing");
  if ((settings.adapter ?? DEFAULT_ADAPTER_ID) !== STRIPE_ADAPTER_ID)
    return missing;
  if (!secrets.apiKey) missing.push("stripe_api_key_missing");
  if (!secrets.webhookSecret) missing.push("stripe_webhook_secret_missing");
  if (settings.stripe?.checkedAt === undefined)
    missing.push("connection_check_missing");
  if (settings.legal?.termsUrl === undefined) missing.push("terms_url_missing");
  return missing;
}
