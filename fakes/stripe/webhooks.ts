// SPDX-License-Identifier: Apache-2.0

// The webhook side of the fake Stripe: signs a body the way Stripe does and plans what Stripe's delivery would send to
// the app's webhook route (duplicate, reordered, delayed, a signature that is stale, wrong, missing or malformed).
//
// The signature scheme is written out again here on purpose and does not import the app's verifier
// (app/src/billing/stripe-webhook-verify.ts): a test that signs with one and verifies with the other proves that both
// follow Stripe's documented rule (`Stripe-Signature: t=<unix seconds>,v1=<hex>[,v0=<hex>]`, HMAC-SHA256 over
// `<t>.<raw body>` made with the secret of the endpoint). The scheme was also checked against the official SDK
// (`stripe.webhooks.generateTestHeaderString` and `constructEvent`), see the pull request of #500.
import { createHmac } from "node:crypto";

/** `Stripe-Signature` for this body: `t=<t>,v1=<hex>`. `t` is in unix seconds. */
export function signStripeWebhook(
  body: string | Buffer,
  secret: string,
  t: number,
): string {
  return `t=${t},v1=${v1(body, secret, t)}`;
}

function v1(body: string | Buffer, secret: string, t: number): string {
  return createHmac("sha256", secret)
    .update(`${t}.`)
    .update(body)
    .digest("hex");
}

/** The legacy `v0` signature of test mode: a digest of the body alone. A verifier ignores it. */
function v0(body: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export const DELIVERY_FAULTS = [
  "stale_timestamp",
  "bad_signature",
  "two_v1_valid_first",
  "two_v1_valid_last",
  "altered_body",
  "missing_signature",
  "malformed_signature",
] as const;
export type DeliveryFault = (typeof DELIVERY_FAULTS)[number];

const WRONG_SECRET_SUFFIX = "_not_the_secret";
const DEFAULT_STALE_SECONDS = 3600;

/** A body that is still JSON-looking but other bytes than the ones that were signed. */
export function alter(body: string): string {
  return `${body} `;
}

/** What goes out for one event: the exact body and the signature header (none for `missing_signature`). */
export function planDelivery(input: {
  body: string;
  secret: string;
  seconds: number;
  fault?: DeliveryFault | undefined;
  staleSeconds?: number | undefined;
}): { body: string; signature: string | undefined } {
  const { body, secret, seconds, fault } = input;
  const wrong = secret + WRONG_SECRET_SUFFIX;
  const sent = fault === "altered_body" ? alter(body) : body;
  const withV0 = (header: string) => `${header},v0=${v0(body, secret)}`;
  switch (fault) {
    case "stale_timestamp":
      return {
        body: sent,
        signature: withV0(
          signStripeWebhook(
            sent,
            secret,
            seconds - (input.staleSeconds ?? DEFAULT_STALE_SECONDS),
          ),
        ),
      };
    case "bad_signature":
      return {
        body: sent,
        signature: withV0(signStripeWebhook(sent, wrong, seconds)),
      };
    case "two_v1_valid_first":
      return {
        body: sent,
        signature: withV0(
          `${signStripeWebhook(sent, secret, seconds)},v1=${v1(sent, wrong, seconds)}`,
        ),
      };
    case "two_v1_valid_last":
      return {
        body: sent,
        signature: withV0(
          `t=${seconds},v1=${v1(sent, wrong, seconds)},v1=${v1(sent, secret, seconds)}`,
        ),
      };
    case "altered_body":
      // Signed over the original, sent with the altered text.
      return {
        body: sent,
        signature: withV0(signStripeWebhook(body, secret, seconds)),
      };
    case "missing_signature":
      return { body: sent, signature: undefined };
    case "malformed_signature":
      return { body: sent, signature: "t=not-a-number,v1" };
    case undefined:
      return {
        body: sent,
        signature: withV0(signStripeWebhook(sent, secret, seconds)),
      };
  }
}
