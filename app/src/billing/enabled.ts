// SPDX-License-Identifier: LicenseRef-Proprietary

// Whether billing is on (ADR 0006, principle 1, 2.14). Every billing route, page and sweep step asks this first: while it is
// false they are inert, a route answers the 404 of a path that does not exist, no billing table is read and nobody is
// called. Billing is on when the instance setting `billing_settings.enabled` is exactly true AND the active adapter is
// ready (#504): A, both B and the Diff AI reserve are set, and for Stripe both credentials are stored and a connection
// check passed (the admin page made it when it switched billing on; the answer is kept in the setting, so asking costs
// no outbound call). It reads the one instance setting, and the two Stripe rows of the secret table by name only for
// Stripe, and calls nobody. This is the one reader of the switch.
import "server-only";
import type { Kysely } from "kysely";
import { createInstanceSettingsStore } from "../db/repositories/instance-settings-store.ts";
import { createSecretsRepository } from "../db/repositories/secrets-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  missingItemsOf,
  STRIPE_ADAPTER_ID,
  type BillingMissingItem,
} from "./readiness.ts";
import {
  DEFAULT_HOURLY_REVIEW_LIMIT,
  DEFAULT_LOW_BALANCE_MICRO_USD,
  billingNumbersOf,
  billingRatesOf,
  type BillingRates,
} from "./rates.ts";
import { DEFAULT_ADAPTER_ID, readBillingSettings } from "./settings.ts";
import {
  isUndecodableText,
  type BillingSettingValues,
} from "./settings-store.ts";

/**
 * The stored value of `billing_settings`, as it is. The one place that reads it: the switch and the active adapter both ask
 * here. Text that is no JSON at all is damaged data like any other, so it reads as not set (a claim must not throw for it,
 * #498); anything else (a lost connection, a busy database) is not a statement about the setting and goes on.
 */
export async function readStoredBillingSettings(
  db: Kysely<Database>,
): Promise<unknown> {
  try {
    return await createInstanceSettingsStore<BillingSettingValues>(db).get(
      "billing_settings",
    );
  } catch (error) {
    if (!isUndecodableText(error)) throw error;
    return undefined;
  }
}

/**
 * The start credit the admin set, in micro-USD (the default where none was set; 0 switches it off). Read here, next to the switch,
 * because this module is the one reader of the stored setting; it says nothing about whether billing is on (#507).
 */
export async function readStartCreditMicroUsd(
  db: Kysely<Database>,
): Promise<number> {
  const stored = await readStoredBillingSettings(db);
  return billingNumbersOf(
    stored === undefined ? {} : readBillingSettings(stored),
  ).startCreditMicroUsd;
}

export type BillingSwitch = {
  /** The switch itself: `billing_settings.enabled` is exactly true. */
  enabled: boolean;
  /** What stands between the setting and a billing that is on (empty: nothing). Only read while the switch is on. */
  missing: BillingMissingItem[];
  /** The complete rates (A, both B, the Diff AI reserve), or null when one is missing. Only read while the switch is on. */
  rates: BillingRates | null;
  /** Started reviews of a workspace in a rolling hour that the hidden brake lets through (#499). Only read while the switch is on. */
  hourlyReviewLimit: number;
  /** Micro-USD below which a balance is low (#504, default 5): where the notifications of #506 begin. Only read while the switch is on. */
  lowBalanceMicroUsd: number;
};

/**
 * The switch and, while it is set, what keeps the adapter from being ready. `isBillingOn` is this reduced to one question;
 * the claim (#498) can tell "off" from "set, but no longer ready" with it, so a job does not run for free when a credential
 * or a rate has gone since the switch was set.
 */
export async function readBillingSwitch(
  db: Kysely<Database>,
): Promise<BillingSwitch> {
  const stored = await readStoredBillingSettings(db);
  const off = {
    enabled: false,
    missing: [],
    rates: null,
    hourlyReviewLimit: DEFAULT_HOURLY_REVIEW_LIMIT,
    lowBalanceMicroUsd: DEFAULT_LOW_BALANCE_MICRO_USD,
  } satisfies BillingSwitch;
  if (stored === undefined) return off;
  const settings = readBillingSettings(stored);
  if (!settings.enabled) return off;
  const usesStripe =
    (settings.adapter ?? DEFAULT_ADAPTER_ID) === STRIPE_ADAPTER_ID;
  const rows = createSecretsRepository(db);
  // The rows are looked for by name; whether they decrypt is checked when they are saved and by the connection check.
  const secrets = usesStripe
    ? {
        apiKey: (await rows.get("stripe_api_key")) !== undefined,
        webhookSecret: (await rows.get("stripe_webhook_secret")) !== undefined,
      }
    : { apiKey: false, webhookSecret: false };
  return {
    enabled: true,
    missing: missingItemsOf({ settings, secrets }),
    rates: billingRatesOf(settings),
    hourlyReviewLimit: billingNumbersOf(settings).hourlyReviewLimit,
    lowBalanceMicroUsd: billingNumbersOf(settings).lowBalanceMicroUsd,
  };
}

export async function isBillingOn(db: Kysely<Database>): Promise<boolean> {
  const state = await readBillingSwitch(db);
  return state.enabled && state.missing.length === 0;
}

/**
 * What keeps billing from running while its switch is on (#632): the claim refuses every review then
 * (`billing_rates_incomplete`), and the admin portal shows these items in a banner on every page. Empty while the switch is
 * off or billing is running.
 */
export async function incompleteBillingItems(
  db: Kysely<Database>,
): Promise<BillingMissingItem[]> {
  const state = await readBillingSwitch(db);
  return state.enabled ? state.missing : [];
}

export type BillingRouteGuard = {
  isOn: () => Promise<boolean>;
  /** Next.js's own 404: the answer of a path that does not exist. Throws. */
  notFound: () => never;
};

/**
 * Wraps the handler of a billing route (the webhook, checkout, the balance page's data): while billing is off the
 * request is answered as a path that does not exist, before the handler or anything it reads is reached.
 */
export function guardBillingRoute<Args extends unknown[]>(
  { isOn, notFound }: BillingRouteGuard,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    if (!(await isOn())) return notFound();
    return handler(...args);
  };
}
