// SPDX-License-Identifier: Apache-2.0

// Whether billing is on (ADR 0005, 2.10). Every billing route, page, admin section and sweep step asks this first:
// while it is false they are inert, a route answers the 404 of a path that does not exist, no billing table is read
// and Paddle is not called. Billing is on when the instance setting `billing_settings.enabled` is true and the
// credentials are complete (an API key, a webhook secret and the client-side token). The answer reads one instance
// setting and, only when the switch is on, whether the two secrets exist; it decrypts nothing and calls nobody.
import "server-only";
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createSecretsRepository } from "../db/repositories/secrets-repository.ts";
import type { Database } from "../db/schema.ts";
import { readBillingSettings } from "./settings.ts";

export async function isBillingOn(db: Kysely<Database>): Promise<boolean> {
  const stored =
    await createInstanceSettingsRepository(db).get("billing_settings");
  if (stored === undefined) return false;
  const settings = readBillingSettings(stored);
  if (!settings.enabled || settings.clientToken === "") return false;
  const secrets = createSecretsRepository(db);
  const [apiKey, webhookSecret] = await Promise.all([
    secrets.get("paddle_api_key"),
    secrets.get("paddle_webhook_secret"),
  ]);
  return apiKey !== undefined && webhookSecret !== undefined;
}

export type BillingRouteGuard = {
  isOn: () => Promise<boolean>;
  /** Next.js's own 404: the answer of a path that does not exist. Throws. */
  notFound: () => never;
};

/**
 * Wraps the handler of a billing route (the webhook, checkout, the plan page's data): while billing is off the
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
