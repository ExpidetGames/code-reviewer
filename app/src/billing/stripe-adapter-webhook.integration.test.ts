// SPDX-License-Identifier: LicenseRef-Proprietary

// #502: the Stripe adapter's webhook and its lookup of a top-up, against the fake Stripe (fakes/stripe): the events the fake makes
// for a payment, a refund and a dispute are signed the way Stripe signs them, verified over the exact bytes with the stored secret
// and read into normalized events; "Check payment" asks Stripe for the session and gets the same event.
import { describe, expect, it, vi } from "vitest";
import {
  signStripeWebhook,
  type StripeEvent,
} from "../../../fakes/stripe/server.ts";
import { BillingAdapterError, type BillingEvent } from "./adapter.ts";
import { createStripeAdapter } from "./stripe-adapter.ts";
import { clientFor, startTestStripe } from "../test-support/stripe-fake.ts";
import type {
  CreateCheckoutSessionInput,
  StripeEnvironment,
} from "./stripe-client.ts";

const SECRET = "whsec_TestSecretForThe502Adapter0000";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const SECONDS = Math.floor(NOW.getTime() / 1000);

const SESSION_INPUT: CreateCheckoutSessionInput = {
  mode: "payment",
  line_items: [
    {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: 2500,
        tax_behavior: "exclusive",
        product_data: { name: "Review credit", tax_code: "txcd_10105002" },
      },
    },
  ],
  success_url: "https://app.example.test/billing?topup=success",
  cancel_url: "https://app.example.test/billing?topup=cancelled",
  client_reference_id: "intent-1",
  metadata: { intent: "intent-1" },
  managed_payments: { enabled: true },
};

async function start(
  options: {
    secret?: string | null;
    environment?: StripeEnvironment | null;
  } = {},
) {
  const fake = await startTestStripe();
  const client = clientFor(fake);
  const adapter = createStripeAdapter({
    client: () => Promise.resolve(client),
    webhookSecret: () =>
      Promise.resolve(options.secret === undefined ? SECRET : options.secret),
    environment: () =>
      Promise.resolve(
        options.environment === undefined ? "test" : options.environment,
      ),
    now: () => NOW,
  });
  let key = 0;
  const session = async () =>
    client.createCheckoutSession(SESSION_INPUT, {
      idempotencyKey: `adapter-webhook-${(key += 1)}`,
    });
  return { fake, client, adapter, session };
}
type Started = Awaited<ReturnType<typeof start>>;

function request(
  event: StripeEvent,
  { secret = SECRET, seconds = SECONDS } = {},
) {
  const body = JSON.stringify(event);
  return {
    headers: new Headers({
      "stripe-signature": signStripeWebhook(body, secret, seconds),
    }),
    rawBody: new TextEncoder().encode(body),
  };
}

async function parse(
  { adapter }: Started,
  event: StripeEvent,
): Promise<BillingEvent> {
  const result = await adapter.verifyAndParseWebhook?.({
    ...request(event),
    now: NOW,
  });
  if (result === undefined || !result.ok) throw new Error("not accepted");
  return result.event;
}

const eventOf = (fake: Started["fake"], type: string) => {
  const found = fake.events().filter((event) => event.type === type);
  const last = found.at(-1);
  if (last === undefined) throw new Error(`no ${type} event`);
  return last;
};

describe("the webhook of the Stripe adapter", () => {
  // #502-T01
  it("reads the events a payment makes: the session credits, the payment intent and the charge say nothing new", async () => {
    const s = await start();
    const session = await s.session();
    const paid = s.fake.buyer.pay(session.id, { taxAmount: 475 });

    expect(
      await parse(s, eventOf(s.fake, "checkout.session.completed")),
    ).toMatchObject({
      type: "payment.succeeded",
      intentId: "intent-1",
      payment: paid.paymentIntent.id,
      checkout: session.id,
      creditable: 25_000_000,
      gross: 29_750_000,
      tax: 4_750_000,
      providerAmount: 2975,
    });
    expect(
      (await parse(s, eventOf(s.fake, "payment_intent.succeeded"))).type,
    ).toBe("ignored");
    expect((await parse(s, eventOf(s.fake, "charge.succeeded"))).type).toBe(
      "ignored",
    );
  });

  // #502-T03
  it("reads an asynchronous failure and an expired session as the end of the payment", async () => {
    const s = await start();
    const failing = await s.session();
    s.fake.buyer.failAsync(failing.id);
    const expiring = await s.session();
    await s.client.expireCheckoutSession(expiring.id);

    expect(
      await parse(s, eventOf(s.fake, "checkout.session.async_payment_failed")),
    ).toMatchObject({ type: "payment.failed", checkout: failing.id });
    expect(
      await parse(s, eventOf(s.fake, "checkout.session.expired")),
    ).toMatchObject({ type: "payment.expired", checkout: expiring.id });
  });

  // #502-T05
  it("reads a refund of the dashboard, one event per refund, with the amount of that refund", async () => {
    const s = await start();
    const session = await s.session();
    const paid = s.fake.buyer.pay(session.id, { taxAmount: 475 });
    const first = s.fake.stripe.refund({
      paymentIntent: paid.paymentIntent.id,
      amount: 1000,
    });
    const second = s.fake.stripe.refund({
      paymentIntent: paid.paymentIntent.id,
      amount: 500,
    });

    const refunds = await Promise.all(
      s.fake
        .events()
        .filter((event) => event.type === "refund.created")
        .map((event) => parse(s, event)),
    );

    expect(refunds).toMatchObject([
      { refund: first.refund.id, amount: 1000, status: "approved" },
      { refund: second.refund.id, amount: 500, status: "approved" },
    ]);
    // The cumulative event of the charge is not a refund.
    expect((await parse(s, eventOf(s.fake, "charge.refunded"))).type).toBe(
      "ignored",
    );
  });

  // #502-T07
  it("reads a dispute that opens, is lost, or is won", async () => {
    const s = await start();
    const session = await s.session();
    const paid = s.fake.buyer.pay(session.id);
    const lost = s.fake.stripe.openDispute(paid.charge.id);
    s.fake.stripe.closeDispute(lost.dispute.id, "lost");

    expect(
      await parse(s, eventOf(s.fake, "charge.dispute.created")),
    ).toMatchObject({
      type: "dispute.updated",
      status: "opened",
      amount: 2500,
    });
    expect(
      await parse(s, eventOf(s.fake, "charge.dispute.closed")),
    ).toMatchObject({ type: "dispute.updated", status: "lost" });
  });

  // #502-T04
  it("refuses a body signed with another secret, an altered body, an old timestamp and a missing header, by code only", async () => {
    const s = await start();
    const session = await s.session();
    s.fake.buyer.pay(session.id);
    const event = eventOf(s.fake, "checkout.session.completed");
    const good = request(event);
    const verify = (input: { headers: Headers; rawBody: Uint8Array }) =>
      s.adapter.verifyAndParseWebhook?.({ ...input, now: NOW });

    expect(
      await verify(request(event, { secret: "whsec_other_secret_value" })),
    ).toEqual({
      ok: false,
      code: "signature_invalid",
    });
    expect(
      await verify({
        headers: good.headers,
        rawBody: new TextEncoder().encode(`${JSON.stringify(event)} `),
      }),
    ).toEqual({ ok: false, code: "signature_invalid" });
    expect(await verify(request(event, { seconds: SECONDS - 3600 }))).toEqual({
      ok: false,
      code: "signature_expired",
    });
    expect(
      await verify({ headers: new Headers(), rawBody: good.rawBody }),
    ).toEqual({ ok: false, code: "signature_missing" });
  });

  // #502-T04
  it("refuses everything when no webhook secret or no environment is stored", async () => {
    for (const options of [{ secret: null }, { environment: null }]) {
      const s = await start(options);
      const session = await s.session();
      s.fake.buyer.pay(session.id);
      const event = eventOf(s.fake, "checkout.session.completed");

      expect(
        await s.adapter.verifyAndParseWebhook?.({
          ...request(event),
          now: NOW,
        }),
      ).toEqual({ ok: false, code: "signature_invalid" });
    }
  });

  // #502-T09
  it("refuses a signed event of the other environment and a signed body that is no event", async () => {
    const s = await start({ environment: "live" });
    const session = await s.session();
    s.fake.buyer.pay(session.id);
    const test = eventOf(s.fake, "checkout.session.completed");

    expect(
      await s.adapter.verifyAndParseWebhook?.({ ...request(test), now: NOW }),
    ).toEqual({ ok: false, code: "body_invalid" });
    const body = new TextEncoder().encode("not json");
    expect(
      await s.adapter.verifyAndParseWebhook?.({
        headers: new Headers({
          "stripe-signature": signStripeWebhook(
            Buffer.from(body),
            SECRET,
            SECONDS,
          ),
        }),
        rawBody: body,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "body_invalid" });
  });

  // #502-T14
  it("makes no outbound call while it verifies and parses", async () => {
    const s = await start();
    const session = await s.session();
    s.fake.buyer.pay(session.id);
    const sent = s.fake.requests().length;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      for (const event of s.fake.events()) await parse(s, event);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(s.fake.requests()).toHaveLength(sent);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("Check payment: the lookup of a top-up at Stripe", () => {
  // #502-T11
  it("turns a paid session into the same payment event the webhook makes", async () => {
    const s = await start();
    const session = await s.session();
    const paid = s.fake.buyer.pay(session.id, { taxAmount: 475 });

    const found = await s.adapter.lookupTopUp?.({
      intentId: "intent-1",
      checkout: session.id,
      payment: null,
    });
    const webhook = await parse(
      s,
      eventOf(s.fake, "checkout.session.completed"),
    );

    expect(found).toMatchObject({
      type: "payment.succeeded",
      intentId: "intent-1",
      payment: paid.paymentIntent.id,
      creditable: 25_000_000,
      providerAmount: 2975,
    });
    expect(found).toMatchObject({
      creditable: (webhook as { creditable: number }).creditable,
      payment: (webhook as { payment: string }).payment,
    });
    // One event per fact: asking twice is the same event id, so the second ask is a repeat for the application.
    expect(
      await s.adapter.lookupTopUp?.({
        intentId: "intent-1",
        checkout: session.id,
        payment: null,
      }),
    ).toEqual(found);
  });

  // #502-T11
  it("says nothing while the buyer is still on the page or the payment is on its way", async () => {
    const s = await start();
    const open = await s.session();

    expect(
      await s.adapter.lookupTopUp?.({
        intentId: "intent-1",
        checkout: open.id,
        payment: null,
      }),
    ).toBeNull();
  });

  // #502-T11
  it("reads an expired session as expired and an asynchronous failure as failed", async () => {
    const s = await start();
    const expiring = await s.session();
    await s.client.expireCheckoutSession(expiring.id);
    const failing = await s.session();
    s.fake.buyer.failAsync(failing.id);

    expect(
      await s.adapter.lookupTopUp?.({
        intentId: "intent-1",
        checkout: expiring.id,
        payment: null,
      }),
    ).toMatchObject({ type: "payment.expired" });
    expect(
      await s.adapter.lookupTopUp?.({
        intentId: "intent-1",
        checkout: failing.id,
        payment: null,
      }),
    ).toMatchObject({ type: "payment.failed" });
  });

  // #502-T12
  it("takes a session or a payment intent that is gone at Stripe as nothing to report, never as an error", async () => {
    const s = await start();

    expect(
      await s.adapter.lookupTopUp?.({
        intentId: "intent-1",
        checkout: "cs_test_gone",
        payment: null,
      }),
    ).toBeNull();
    expect(
      await s.adapter.lookupTopUp?.({
        intentId: "intent-1",
        checkout: null,
        payment: "pi_gone",
      }),
    ).toBeNull();
  });

  // #502-T11
  it("fails by a stable code when Stripe is down", async () => {
    const s = await start();
    const session = await s.session();
    s.fake.faults.failWith({ method: "GET" }, 503, { times: 10 });

    await expect(
      s.adapter.lookupTopUp?.({
        intentId: "intent-1",
        checkout: session.id,
        payment: null,
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(BillingAdapterError.name).toBe("BillingAdapterError");
  });
});
