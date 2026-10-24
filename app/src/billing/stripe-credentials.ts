// SPDX-License-Identifier: LicenseRef-Proprietary

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
  type StripeEnvironment,
} from "./stripe-client.ts";

const STRIPE_API_KEY = "stripe_api_key";
const STRIPE_WEBHOOK_SECRET = "stripe_webhook_secret";

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

/** The signing secret of the webhook endpoint the admin stored (#504), read when a webhook arrives; null while there is none. */
export function stripeWebhookSecretFromSecrets({
  secrets,
}: {
  secrets: () => SecretStore;
}): () => Promise<string | null> {
  return async () => {
    const secret = await secrets().use(STRIPE_WEBHOOK_SECRET);
    return secret.ok ? secret.value.reveal() : null;
  };
}

/**
 * The environment of the stored API key, from its prefix alone (the key is read, looked at and forgotten): the environment
 * whose events the webhook and "Check payment" accept. Null while there is no key or it is of no shape.
 */
export function stripeEnvironmentFromSecrets({
  secrets,
}: {
  secrets: () => SecretStore;
}): () => Promise<StripeEnvironment | null> {
  return async () => {
    const key = await secrets().use(STRIPE_API_KEY);
    return key.ok ? stripeKeyEnvironment(key.value.reveal()) : null;
  };
}
