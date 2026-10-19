// SPDX-License-Identifier: Apache-2.0

// The instance setting `billing_settings` (ADR 0006): today only the switch, later also the rates. Pure: no database. A
// stored value of an older shape (it also carried an environment, a client token and grace days) reads leniently: the
// fields it no longer has are ignored.
import "server-only";

export type BillingSettings = {
  /** The switch. Billing is on when this is exactly `true` (`isBillingOn`). */
  enabled: boolean;
};

/** Billing never configured: off. */
export const DEFAULT_BILLING_SETTINGS: BillingSettings = { enabled: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stored value as settings. `enabled` is only true when it is exactly `true`: a setting that cannot be read, or
 * that says `"true"`, never switches billing on.
 */
export function readBillingSettings(stored: unknown): BillingSettings {
  if (!isRecord(stored)) return DEFAULT_BILLING_SETTINGS;
  return { enabled: stored.enabled === true };
}
