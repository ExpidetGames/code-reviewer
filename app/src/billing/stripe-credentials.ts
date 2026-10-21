// SPDX-License-Identifier: Apache-2.0

// The Stripe client of the instance, made from the API key the instance admin stored (#504) at the moment a top-up needs it,
// never at startup and never while billing is off. The environment (`test` or `live`) is the one the key's prefix says, and the
// client refuses a key of any other shape (`environment_mismatch`), so a typo or a publishable key never reaches Stripe. The
// key is read, used to make the client and forgotten; it is in no error and no log.
import "server-only";
import type { SecretStore } from "../secrets/store.ts";
import {
  StripeClientError,
  createStripeClient,
  stripeKeyEnvironment,
  type StripeClient,
} from "./stripe-client.ts";

const STRIPE_API_KEY = "stripe_api_key";

export function stripeClientFromSecrets({
  secrets,
  baseUrl,
}: {
  /** Made when it is needed: the master key is read from the environment then. */
  secrets: () => SecretStore;
  /** `STRIPE_API_BASE_URL` on the running server, the fake's address in a test. */
  baseUrl: string;
}): () => Promise<StripeClient> {
  return async () => {
    const key = await secrets().use(STRIPE_API_KEY);
    if (!key.ok) throw new StripeClientError("invalid_configuration");
    const apiKey = key.value.reveal();
    const environment = stripeKeyEnvironment(apiKey);
    if (environment === null)
      throw new StripeClientError("environment_mismatch");
    return createStripeClient({ apiKey, baseUrl, environment });
  };
}
