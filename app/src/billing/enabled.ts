// SPDX-License-Identifier: Apache-2.0

// Whether billing is on (ADR 0006, principle 1). Every billing route, page and sweep step asks this first: while it is
// false they are inert, a route answers the 404 of a path that does not exist, no billing table is read and nobody is
// called. For now billing is on when the instance setting `billing_settings.enabled` is exactly true; the readiness of
// the payment adapter joins the answer with the adapter (#501, #504). It reads one instance setting and calls nobody.
// This is the one reader of the switch.
import "server-only";
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import { readBillingSettings } from "./settings.ts";

/** The stored value of `billing_settings`, as it is. The one place that reads it: the switch and the active adapter both ask here. */
export function readStoredBillingSettings(
  db: Kysely<Database>,
): Promise<unknown> {
  return createInstanceSettingsRepository(db).get("billing_settings");
}

export async function isBillingOn(db: Kysely<Database>): Promise<boolean> {
  const stored = await readStoredBillingSettings(db);
  return stored !== undefined && readBillingSettings(stored).enabled;
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
