// SPDX-License-Identifier: Apache-2.0

// The fake Stripe of the billing journeys (`fakes/stripe`, started by playwright.config.ts) and the admin routes that point billing
// at it, the way an operator would in the admin portal: the Stripe adapter, an API key, a webhook endpoint at the app, the rates, the
// connection check and the switch. The journeys use the pages for what a person does; this is the set-up they stand on.
import { expect, request, type APIRequestContext } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

/** The version header the app's client sends; the fake records it and accepts any. */
const STRIPE_VERSION = "2025-03-31.basil; managed_payments_preview=v1";

async function adminClient(baseURL: string): Promise<APIRequestContext> {
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
 * Puts billing of the app at `appUrl` on the Stripe adapter against the fake: made-up rates, the fake's API key, a webhook endpoint at
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

/** The buyer pays an open Checkout session at the fake. The events wait until `deliverEvents`. */
export async function payFakeSession(sessionId: string): Promise<void> {
  const stripe = await request.newContext({ baseURL: e2eEnv.stripeFakeUrl });
  try {
    const paid = await stripe.post("/__fake/pay", {
      data: { session: sessionId },
    });
    expect(paid.status(), await paid.text()).toBe(200);
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
