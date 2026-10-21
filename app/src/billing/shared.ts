// SPDX-License-Identifier: Apache-2.0

// The wiring of the billing routes: the real database, the adapters this instance has and the switch. This is the one place
// that decides which adapters exist; the Stripe adapter joins the list with #501 and #502. It also holds the services of
// the billing page of the admin portal (#504) and the billing measures of the running server (#493): what the queue reports
// when a claim ended, handed to the platform to run after the response like every other reaction (src/dispatch/shared.ts).
import "server-only";
import { notFound } from "next/navigation";
import { loadAuthConfig } from "../auth/config.ts";
import { getDatabase } from "../db/startup.ts";
import { runAfterResponse } from "../dispatch/shared.ts";
import { getSecretStoreOn } from "../secrets/shared.ts";
import { createAdapterRegistry } from "./adapter.ts";
import {
  createBillingCreditService,
  type BillingCreditService,
} from "./admin-credit-service.ts";
import {
  createBillingAdminService,
  type BillingAdminService,
} from "./admin-service.ts";
import { createStripeClient, STRIPE_API_BASE_URL } from "./stripe-client.ts";
import { createActiveAdapterResolver } from "./active-adapter.ts";
import { isBillingOn } from "./enabled.ts";
import { manualAdapter } from "./manual-adapter.ts";
import { createWallClockRecorder } from "./wall-clock.ts";
import { createBillingWebhookHandler } from "./webhook-handler.ts";

export function getBillingAdapterRegistry() {
  return createAdapterRegistry([manualAdapter]);
}

/** The handler of `POST /api/billing/webhook`, wired to the running server. */
export function getBillingWebhookHandler(): (
  request: Request,
) => Promise<Response> {
  const db = getDatabase();
  return createBillingWebhookHandler({
    db,
    guard: { isOn: () => isBillingOn(db), notFound },
    activeAdapter: createActiveAdapterResolver(db, getBillingAdapterRegistry()),
  });
}

/**
 * The billing settings of the admin portal on the running server (#504). The public address is the configured one
 * (`BETTER_AUTH_URL`), never a request header, and the Stripe address is Stripe's own: there is no setting for it, because the API key goes there. Nothing is
 * called until the admin presses a button.
 */
export function getBillingAdminService(): BillingAdminService {
  return createBillingAdminService({
    db: getDatabase(),
    secretsOn: getSecretStoreOn,
    publicUrl: loadAuthConfig(process.env).baseUrl,
    clientFor: (apiKey, environment) =>
      createStripeClient({
        apiKey,
        baseUrl: STRIPE_API_BASE_URL,
        environment,
      }),
  });
}

/** The manual credit of the admin portal on the running server (#504). */
export function getBillingCreditService(): BillingCreditService {
  return createBillingCreditService({ db: getDatabase() });
}

/** The claims of these jobs ended: records the wall clock of those that ran on a runner, where billing is on. Never throws, never delays the call. */
export function recordWallClocks(jobIds: readonly string[]): void {
  if (jobIds.length === 0) return;
  try {
    const recorder = createWallClockRecorder({ db: getDatabase() });
    runAfterResponse(() => recorder.recordFor(jobIds));
  } catch {
    console.error("[billing] WALL_CLOCK_NOT_RECORDED");
  }
}
