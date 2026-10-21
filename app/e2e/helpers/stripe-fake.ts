// SPDX-License-Identifier: Apache-2.0

// The fake Stripe of the billing journeys (`fakes/stripe`, started by playwright.config.ts) and the admin routes that point billing
// at it, the way an operator would in the admin portal: the Stripe adapter, an API key, a webhook endpoint at the app, the rates, the
// connection check and the switch. The journeys use the pages for what a person does; this is the set-up they stand on.
import { expect, request, type APIRequestContext } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

/** The version header the app's client sends; the fake records it and accepts any. */
const STRIPE_VERSION = "2025-03-31.basil; managed_payments_preview=v1";

export async function adminClient(baseURL: string): Promise<APIRequestContext> {
  const client = await request.newContext({ baseURL });
  const signedIn = await client.post("/api/auth/sign-in/email", {
    data: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  return client;
}

/** Creates the webhook endpoint the fake delivers to (the app's webhook route) and returns its signing secret. */
async function createWebhookEndpoint(appUrl: string): Promise<string> {
  const stripe = await request.newContext({ baseURL: e2eEnv.stripeFakeUrl });
  try {
    // One endpoint for the app: the fake delivers every event to every endpoint, and the app holds the secret of the last one only,
    // so an endpoint an earlier journey made would be delivered to with a secret the app no longer has (and answer 400).
    const headers = {
      authorization: `Bearer ${e2eEnv.stripeFakeApiKey}`,
      "stripe-version": STRIPE_VERSION,
    };
    const listed = await stripe.get("/v1/webhook_endpoints?limit=100", {
      headers,
    });
    expect(listed.status(), await listed.text()).toBe(200);
    const { data } = (await listed.json()) as {
      data: Array<{ id: string; url: string }>;
    };
    for (const endpoint of data.filter(
      (one) => one.url === `${appUrl}/api/billing/webhook`,
    )) {
      const removed = await stripe.delete(
        `/v1/webhook_endpoints/${endpoint.id}`,
        {
          headers,
        },
      );
      expect(removed.status(), await removed.text()).toBe(200);
    }
    const created = await stripe.post("/v1/webhook_endpoints", {
      headers: {
        authorization: `Bearer ${e2eEnv.stripeFakeApiKey}`,
        "stripe-version": STRIPE_VERSION,
      },
      form: {
        url: `${appUrl}/api/billing/webhook`,
        "enabled_events[0]": "*",
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    const body = (await created.json()) as { secret?: unknown };
    expect(typeof body.secret).toBe("string");
    return body.secret as string;
  } finally {
    await stripe.dispose();
  }
}

/**
 * Puts billing of the app at `appUrl` on the Stripe adapter against the fake: made-up rates, the terms link, the fake's API key, a webhook endpoint at
 * the app, a passing connection check, and the switch on. Every step is idempotent, so a journey may call it at its start.
 */
export async function switchBillingOnWithFakeStripe(
  appUrl: string,
): Promise<void> {
  const secret = await createWebhookEndpoint(appUrl);
  const admin = await adminClient(appUrl);
  try {
    const change = async (data: Record<string, unknown>) => {
      const answer = await admin.put("/api/admin/billing", { data });
      expect(answer.status(), await answer.text()).toBe(200);
    };
    await change({ enabled: false });
    await change({ adapter: "stripe" });
    await change({
      stripe: { apiKey: e2eEnv.stripeFakeApiKey, webhookSecret: secret },
    });
    await change({
      rates: {
        factorA: 50_000,
        minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
        diffAiReserveMicroUsd: 150_000,
      },
    });
    // The Stripe adapter is not ready without the link to the terms (#626).
    await change({
      legal: {
        termsUrl: "https://example.com/terms",
        privacyUrl: "https://example.com/privacy",
      },
    });
    const checked = await admin.post("/api/admin/billing/check", { data: {} });
    expect(checked.status(), await checked.text()).toBe(200);
    expect(await checked.json()).toMatchObject({ ok: true });
    await change({ enabled: true });
  } finally {
    await admin.dispose();
  }
}

/** Switches billing off again (the rates, the credentials and the journal stay). */
export async function switchBillingOff(appUrl: string): Promise<void> {
  const admin = await adminClient(appUrl);
  try {
    const answer = await admin.put("/api/admin/billing", {
      data: { enabled: false },
    });
    expect(answer.status(), await answer.text()).toBe(200);
  } finally {
    await admin.dispose();
  }
}

/** The ids Stripe gave a payment: its PaymentIntent and its charge (what a refund or a dispute names). */
export type FakePayment = { paymentIntent: string; charge: string };

/** The buyer pays an open Checkout session at the fake. The events wait until `deliverEvents`. */
export async function payFakeSession(sessionId: string): Promise<FakePayment> {
  const stripe = await request.newContext({ baseURL: e2eEnv.stripeFakeUrl });
  try {
    const paid = await stripe.post("/__fake/pay", {
      data: { session: sessionId },
    });
    expect(paid.status(), await paid.text()).toBe(200);
    const body = (await paid.json()) as {
      payment_intent: string;
      charge: string;
    };
    return { paymentIntent: body.payment_intent, charge: body.charge };
  } finally {
    await stripe.dispose();
  }
}

/** The fake sends the events it has not sent yet to the app's webhook route, signed; returns the statuses the app answered. */
export async function deliverEvents(): Promise<Array<number | null>> {
  const stripe = await request.newContext({ baseURL: e2eEnv.stripeFakeUrl });
  try {
    const flushed = await stripe.post("/__fake/flush", { data: {} });
    expect(flushed.status(), await flushed.text()).toBe(200);
    const body = (await flushed.json()) as {
      data: Array<{ status: number | null }>;
    };
    return body.data.map((delivery) => delivery.status);
  } finally {
    await stripe.dispose();
  }
}

/** Stripe refunds a payment (all of it, or `amountCents`). The events wait until `deliverEvents`. */
export async function refundFakePayment(
  payment: FakePayment,
  amountCents?: number,
): Promise<void> {
  const stripe = await request.newContext({ baseURL: e2eEnv.stripeFakeUrl });
  try {
    const refunded = await stripe.post("/__fake/refund", {
      data: {
        payment_intent: payment.paymentIntent,
        ...(amountCents === undefined ? {} : { amount: amountCents }),
      },
    });
    expect(refunded.status(), await refunded.text()).toBe(200);
  } finally {
    await stripe.dispose();
  }
}

/** The buyer's bank disputes a payment (a chargeback); returns the dispute id. The events wait until `deliverEvents`. */
export async function openFakeDispute(payment: FakePayment): Promise<string> {
  const stripe = await request.newContext({ baseURL: e2eEnv.stripeFakeUrl });
  try {
    const opened = await stripe.post("/__fake/dispute", {
      data: { charge: payment.charge },
    });
    expect(opened.status(), await opened.text()).toBe(200);
    return ((await opened.json()) as { dispute: string }).dispute;
  } finally {
    await stripe.dispose();
  }
}

/** Puts billing on the manual adapter (no provider: the operator credits by hand) with the rates already saved, and switches it on. */
export async function switchBillingOnWithManualAdapter(
  appUrl: string,
): Promise<void> {
  const admin = await adminClient(appUrl);
  try {
    const change = async (data: Record<string, unknown>) => {
      const answer = await admin.put("/api/admin/billing", { data });
      expect(answer.status(), await answer.text()).toBe(200);
    };
    await change({ enabled: false });
    await change({ adapter: "manual" });
    await change({
      rates: {
        factorA: 50_000,
        minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
        diffAiReserveMicroUsd: 150_000,
      },
    });
    await change({ enabled: true });
  } finally {
    await admin.dispose();
  }
}
