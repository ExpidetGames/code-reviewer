// SPDX-License-Identifier: Apache-2.0

// The instance setting `billing_settings` (ADR 0006): the switch and the rates (src/billing/rates.ts). Pure: no database.
// Read leniently: a stored value of an older shape (it also carried an environment, a client token and grace days) has
// the fields it no longer has ignored, and a rate that is damaged reads as not set. Written only through the rates
// service (`rates-service.ts`) and, for the switch, the admin form (#504).
import "server-only";
import {
  isDiffAiReserve,
  isFactorA,
  isMinuteRate,
  isRecord,
  type StoredBillingRates,
} from "./rates.ts";

export type BillingSettings = StoredBillingRates & {
  /** The switch. Billing is on when this is exactly `true` (`isBillingOn`). */
  enabled: boolean;
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
  return rates;
}

/**
 * The stored value as settings. `enabled` is only true when it is exactly `true`: a setting that cannot be read, or
 * that says `"true"`, never switches billing on. A rate that is damaged (a string, a float, out of bounds) is left out,
 * which reads as not set.
 */
export function readBillingSettings(stored: unknown): BillingSettings {
  if (!isRecord(stored)) return DEFAULT_BILLING_SETTINGS;
  return { enabled: stored.enabled === true, ...readRates(stored) };
}
