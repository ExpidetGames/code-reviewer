// SPDX-License-Identifier: Apache-2.0

// The billing module on the running server: the settings service over the server's database, the secret store and
// Paddle's own address for the configured environment, and the one question every billing route asks first. Server code
// only. Nothing is cached: every call reads the database, so a change counts from the next request on every instance.
import "server-only";
import { loadAuthConfig } from "../auth/config.ts";
import { getDatabase } from "../db/startup.ts";
import { getSecretStore } from "../secrets/shared.ts";
import { isBillingOn } from "./enabled.ts";
import { createPaddleClient, paddleBaseUrl } from "./paddle-client.ts";
import {
  createBillingPlansService,
  type BillingPlansService,
} from "./plans-service.ts";
import {
  createBillingPricesService,
  type BillingPricesService,
} from "./prices-service.ts";
import {
  createBillingSettingsService,
  type BillingSettingsService,
} from "./settings-service.ts";

/** The plans (#438): the plans page and its data routes, and the Free plan that billing switches on with. */
export function getBillingPlansService(): BillingPlansService {
  return createBillingPlansService({ db: getDatabase() });
}

/** The Paddle prices linked to plan versions (#439): reads from Paddle with the stored key, never writes. */
export function getBillingPricesService(): BillingPricesService {
  return createBillingPricesService({
    db: getDatabase(),
    secrets: getSecretStore(),
    clientFor: (apiKey, environment) =>
      createPaddleClient({ apiKey, baseUrl: paddleBaseUrl(environment) }),
  });
}

export function getBillingSettingsService(): BillingSettingsService {
  return createBillingSettingsService({
    db: getDatabase(),
    plans: getBillingPlansService(),
    secrets: getSecretStore(),
    clientFor: (apiKey, environment) =>
      createPaddleClient({ apiKey, baseUrl: paddleBaseUrl(environment) }),
    // The address Paddle is told to post to comes from the configuration, never from a request header.
    publicUrl: loadAuthConfig(process.env).baseUrl,
  });
}

/** Whether billing is on right now; billing routes, pages and sweep steps call this before anything else. */
export function isBillingOnNow(): Promise<boolean> {
  return isBillingOn(getDatabase(), getSecretStore());
}
