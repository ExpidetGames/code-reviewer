// SPDX-License-Identifier: LicenseRef-Proprietary

// The webhook side of the fake Stripe API (fakes/stripe): the events a payment, a refund and a dispute make, their
// signed delivery (duplicate, reordered, delayed, every fault of the signature) and the buyer helper, checked with the
// app's own verifier. The fake signs with a copy of the scheme of its own, so a delivery that verifies here proves that
// the two follow the same documented rule.
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  startStripeFake,
  type StripeEvent,
} from "../../../fakes/stripe/server.ts";
import {
  clientFor,
  startTestStripe,
  uniqueIdempotencyKey,
} from "../test-support/stripe-fake.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import type { CreateCheckoutSessionInput } from "./stripe-client.ts";
import { verifyStripeSignature } from "./stripe-webhook-verify.ts";

type Received = { headers: Record<string, string>; body: Buffer };

/** A loopback receiver standing in for the app's webhook route. It records the bytes and answers `status`. */
async function startReceiver(status = 200) {
  const received: Received[] = [];
  const answer = { status };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([k, v]) => [k, String(v)]),
        ),
        body: Buffer.concat(chunks),
      });
      response.writeHead(answer.status);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanUpAfterTest(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/billing/webhook`,
    received,
    answer,
  };
}

const SESSION_INPUT: CreateCheckoutSessionInput = {
  mode: "payment",
  line_items: [
    {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: 2500,
        tax_behavior: "exclusive",
        product_data: { name: "Credit", tax_code: "txcd_10103001" },
      },
    },
  ],
  success_url: "https://app.example.test/billing?paid=1",
  cancel_url: "https://app.example.test/billing",
  metadata: { intent: "intent-1" },
  managed_payments: { enabled: true },
};

async function setup(
  options: {
    events?: string[];
    fakeOptions?: Parameters<typeof startTestStripe>[0];
  } = {},
) {
  const fake = await startTestStripe(options.fakeOptions);
  const client = clientFor(fake);
  const receiver = await startReceiver();
  const endpoint = await client.createWebhookEndpoint({
    url: receiver.url,
    enabled_events: options.events ?? ["*"],
  });
  const secret = endpoint.secret ?? "";
  expect(secret).not.toBe("");
  const session = await client.createCheckoutSession(SESSION_INPUT, {
    idempotencyKey: uniqueIdempotencyKey(),
  });
  return { fake, client, receiver, endpoint, secret, session };
}

const parse = (received: Received) =>
  JSON.parse(received.body.toString("utf8")) as StripeEvent;
const types = (received: Received[]) => received.map((r) => parse(r).type);

function verdictOf(received: Received, secret: string, now: Date = new Date()) {
  return verifyStripeSignature({
    header: received.headers["stripe-signature"],
    rawBody: received.body,
    secret,
    now,
  });
}

describe("the buyer pays a session", () => {
  // #500-T11
  it("completes the session and makes a payment intent and a charge whose ids agree, with the events of a payment", async () => {
    const { fake, client, session } = await setup();
    const paid = fake.buyer.pay(session.id, { taxAmount: 475 });

    expect(paid.session).toMatchObject({
      id: session.id,
      status: "complete",
      payment_status: "paid",
      payment_intent: paid.paymentIntent.id,
      amount_subtotal: 2500,
      amount_total: 2975,
      total_details: { amount_tax: 475 },
    });
    expect(paid.paymentIntent).toMatchObject({
      status: "succeeded",
      amount: 2975,
      amount_received: 2975,
      currency: "usd",
      latest_charge: paid.charge.id,
    });
    expect(paid.charge).toMatchObject({
      amount: 2975,
      amount_refunded: 0,
      status: "succeeded",
      paid: true,
      refunded: false,
      disputed: false,
      payment_intent: paid.paymentIntent.id,
    });

    // Through the API, the same facts.
    const fetched = await client.getCheckoutSession(session.id);
    expect(fetched).toMatchObject({
      status: "complete",
      payment_status: "paid",
      payment_intent: paid.paymentIntent.id,
    });
    expect(fetched.url).toBeNull();
    expect(await client.getPaymentIntent(paid.paymentIntent.id)).toMatchObject({
      latest_charge: paid.charge.id,
    });
    expect(await client.getCharge(paid.charge.id)).toMatchObject({
      payment_intent: paid.paymentIntent.id,
    });

    const events = fake.events();
    expect(events.map((event) => event.type)).toEqual([
      "payment_intent.succeeded",
      "charge.succeeded",
      "checkout.session.completed",
    ]);
    const [intentEvent, chargeEvent, sessionEvent] = events;
    expect(sessionEvent?.data.object).toMatchObject({
      id: session.id,
      payment_intent: paid.paymentIntent.id,
      payment_status: "paid",
      metadata: { intent: "intent-1" },
    });
    expect(intentEvent?.data.object).toMatchObject({
      id: paid.paymentIntent.id,
      latest_charge: paid.charge.id,
    });
    expect(chargeEvent?.data.object).toMatchObject({
      id: paid.charge.id,
      payment_intent: paid.paymentIntent.id,
    });
  });

  // #500-T11
  it("delivers those events, signed, to a subscribed endpoint", async () => {
    const { fake, receiver, secret, session } = await setup();
    fake.buyer.pay(session.id);
    const results = await fake.flush();
    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(types(receiver.received)).toEqual([
      "payment_intent.succeeded",
      "charge.succeeded",
      "checkout.session.completed",
    ]);
    for (const received of receiver.received) {
      expect(verdictOf(received, secret).ok).toBe(true);
      expect(received.headers["content-type"]).toContain("application/json");
    }
    // Delivered is delivered: a second flush sends nothing.
    expect(await fake.flush()).toEqual([]);
  });

  // #500-T11
  it("pays in the buyer's currency when asked to, while the session stays in dollars (Adaptive Pricing)", async () => {
    const { fake, session } = await setup();
    const paid = fake.buyer.pay(session.id, {
      charged: { currency: "eur", amount: 2310 },
    });
    expect(paid.session.currency).toBe("usd");
    expect(paid.paymentIntent).toMatchObject({ currency: "eur", amount: 2310 });
    expect(paid.charge).toMatchObject({ currency: "eur", amount: 2310 });
    // The session says what the buyer paid, the way Stripe does since API version 2025-03-31 (#502).
    expect(paid.session.presentment_details).toEqual({
      presentment_amount: 2310,
      presentment_currency: "eur",
    });
  });

  // #502-T17
  it("takes a discount off the subtotal and says so in the total details of the paid session", async () => {
    const { fake, session } = await setup();
    const paid = fake.buyer.pay(session.id, {
      taxAmount: 500,
      discountAmount: 250,
    });
    expect(paid.session).toMatchObject({
      amount_subtotal: 2500,
      amount_total: 2750,
      total_details: { amount_discount: 250, amount_tax: 500 },
    });
    expect(paid.paymentIntent).toMatchObject({ amount: 2750 });
  });

  // #500-T11
  it("carries the customer of the session to the payment intent", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    const customer = await client.createCustomer({ name: "Example GmbH" });
    const session = await client.createCheckoutSession(
      { ...SESSION_INPUT, customer: customer.id },
      { idempotencyKey: uniqueIdempotencyKey() },
    );
    const paid = fake.buyer.pay(session.id);
    expect(paid.paymentIntent.customer).toBe(customer.id);
  });

  // #500-T11
  it("cannot pay a session twice, one that expired, or one that does not exist", async () => {
    const { fake, client, session } = await setup();
    fake.buyer.pay(session.id);
    expect(() => fake.buyer.pay(session.id)).toThrow(/not open/);
    const other = await client.createCheckoutSession(SESSION_INPUT, {
      idempotencyKey: uniqueIdempotencyKey(),
    });
    await client.expireCheckoutSession(other.id);
    expect(() => fake.buyer.pay(other.id)).toThrow(/not open/);
    expect(() => fake.buyer.pay("cs_test_Nothing")).toThrow(/No such/);
  });

  // #500-T11
  it("makes the event of an expired session and of a payment that failed later", async () => {
    const { fake, client, session } = await setup();
    await client.expireCheckoutSession(session.id);
    const second = await client.createCheckoutSession(SESSION_INPUT, {
      idempotencyKey: uniqueIdempotencyKey(),
    });
    fake.buyer.failAsync(second.id);
    expect(fake.events().map((event) => event.type)).toEqual([
      "checkout.session.expired",
      "checkout.session.async_payment_failed",
    ]);
    expect(fake.events()[1]?.data.object).toMatchObject({
      id: second.id,
      payment_status: "unpaid",
    });
  });

  // #500-T11
  it("gives events and objects the ids and times of a run that is the same every time", async () => {
    const run = async () => {
      const { fake, session } = await setup({
        fakeOptions: { now: () => 1_700_000_000_000 },
      });
      const paid = fake.buyer.pay(session.id);
      return {
        events: fake
          .events()
          .map((event) => [event.id, event.type, event.created]),
        ids: [session.id, paid.paymentIntent.id, paid.charge.id],
      };
    };
    expect(await run()).toEqual(await run());
    const first = await run();
    expect(first.events[0]?.[0]).toBe("evt_Fake00000001");
    expect(first.events[0]?.[2]).toBe(1_700_000_000);
  });
});

describe("refunds and disputes that Stripe starts", () => {
  // #500-T11
  it("makes charge.refunded and refund.created for a refund from the dashboard, partial and then full", async () => {
    const { fake, session } = await setup();
    const paid = fake.buyer.pay(session.id);
    const first = fake.stripe.refund({ charge: paid.charge.id, amount: 1000 });
    expect(first.refund).toMatchObject({
      amount: 1000,
      status: "succeeded",
      charge: paid.charge.id,
      payment_intent: paid.paymentIntent.id,
    });
    expect(first.charge).toMatchObject({
      amount_refunded: 1000,
      refunded: false,
    });
    const second = fake.stripe.refund({
      paymentIntent: paid.paymentIntent.id,
    });
    expect(second.refund.amount).toBe(1500);
    expect(second.charge).toMatchObject({
      amount_refunded: 2500,
      refunded: true,
    });
    expect(() => fake.stripe.refund({ charge: paid.charge.id })).toThrow(
      /already/,
    );
    const refundEvents = fake
      .events()
      .filter(
        (event) =>
          event.type.startsWith("charge.refunded") ||
          event.type === "refund.created",
      );
    expect(refundEvents.map((event) => event.type)).toEqual([
      "charge.refunded",
      "refund.created",
      "charge.refunded",
      "refund.created",
    ]);
    // A refund of the dashboard has no API request behind it.
    expect(refundEvents[0]?.request).toEqual({
      id: null,
      idempotency_key: null,
    });
    // The charge of the event is the charge as it was then; the cumulative amount is on it.
    expect(refundEvents[0]?.data.object).toMatchObject({
      amount_refunded: 1000,
    });
    expect(refundEvents[2]?.data.object).toMatchObject({
      amount_refunded: 2500,
    });
  });

  // #500-T11
  it("makes the same events for a refund that the app asks for, with the request on the event", async () => {
    const { fake, client, session } = await setup();
    const paid = fake.buyer.pay(session.id);
    const refund = await client.createRefund(
      { charge: paid.charge.id, amount: 500 },
      { idempotencyKey: "refund-1" },
    );
    const event = fake.events().find((e) => e.type === "refund.created");
    expect(event?.data.object).toMatchObject({ id: refund.id, amount: 500 });
    expect(event?.request.idempotency_key).toBe("refund-1");
    expect(event?.request.id).toMatch(/^req_/);
  });

  // #500-T11
  it("refuses a refund of more than is left, of an unpaid session and of a payment that was never made", async () => {
    const { fake, client, session } = await setup();
    const paid = fake.buyer.pay(session.id);
    const tooMuch = await client
      .createRefund(
        { charge: paid.charge.id, amount: 2501 },
        { idempotencyKey: uniqueIdempotencyKey("refund") },
      )
      .catch((error: unknown) => error);
    expect(tooMuch).toMatchObject({ code: "bad_request", status: 400 });
    const unknown = await client
      .createRefund(
        { charge: "ch_Nothing" },
        { idempotencyKey: uniqueIdempotencyKey("refund") },
      )
      .catch((error: unknown) => error);
    expect(unknown).toMatchObject({ code: "not_found" });
    expect(fake.refunds()).toHaveLength(0);
  });

  // #500-T11
  it("fails a refund later: the status, and refund.updated and refund.failed", async () => {
    const { fake, session } = await setup();
    const paid = fake.buyer.pay(session.id);
    const { refund } = fake.stripe.refund({
      charge: paid.charge.id,
      amount: 1000,
    });
    const failed = fake.stripe.failRefund(refund.id);
    expect(failed.refund).toMatchObject({ status: "failed" });
    expect(failed.charge.amount_refunded).toBe(0);
    expect(
      fake
        .events()
        .slice(-2)
        .map((event) => event.type),
    ).toEqual(["refund.updated", "refund.failed"]);
    expect(fake.events().at(-1)?.data.object).toMatchObject({
      id: refund.id,
      status: "failed",
    });
  });

  // #500-T11
  it("opens and closes a dispute with its events: created and funds withdrawn, then closed (and funds reinstated when won)", async () => {
    const { fake, session } = await setup();
    const paid = fake.buyer.pay(session.id);
    const opened = fake.stripe.openDispute(paid.charge.id, {
      reason: "fraudulent",
    });
    expect(opened.dispute).toMatchObject({
      status: "needs_response",
      amount: 2500,
      charge: paid.charge.id,
      payment_intent: paid.paymentIntent.id,
      reason: "fraudulent",
    });
    expect(opened.charge.disputed).toBe(true);
    const lost = fake.stripe.closeDispute(opened.dispute.id, "lost");
    expect(lost.status).toBe("lost");

    const second = fake.buyer.pay(
      (
        await clientFor(fake).createCheckoutSession(SESSION_INPUT, {
          idempotencyKey: uniqueIdempotencyKey(),
        })
      ).id,
    );
    const wonDispute = fake.stripe.openDispute(second.charge.id, {
      amount: 1000,
    });
    expect(wonDispute.dispute.amount).toBe(1000);
    expect(fake.stripe.closeDispute(wonDispute.dispute.id, "won").status).toBe(
      "won",
    );

    const disputeEvents = fake
      .events()
      .filter((event) => event.type.startsWith("charge.dispute."));
    expect(disputeEvents.map((event) => event.type)).toEqual([
      "charge.dispute.created",
      "charge.dispute.funds_withdrawn",
      "charge.dispute.closed",
      "charge.dispute.created",
      "charge.dispute.funds_withdrawn",
      "charge.dispute.closed",
      "charge.dispute.funds_reinstated",
    ]);
    expect(disputeEvents[2]?.data.object).toMatchObject({ status: "lost" });
    expect(disputeEvents[5]?.data.object).toMatchObject({ status: "won" });
    expect(() => fake.stripe.closeDispute(opened.dispute.id, "won")).toThrow(
      /already closed/,
    );
  });
});

describe("delivery", () => {
  // #500-T10
  it("delivers an event twice, byte for byte the same, and both verify", async () => {
    const { fake, receiver, secret, session } = await setup({
      events: ["checkout.session.completed"],
    });
    fake.buyer.pay(session.id);
    const results = await fake.flush({ duplicates: 1 });
    expect(results).toHaveLength(2);
    expect(receiver.received).toHaveLength(2);
    expect(
      receiver.received[0]?.body.equals(
        receiver.received[1]?.body ?? Buffer.alloc(0),
      ),
    ).toBe(true);
    for (const received of receiver.received)
      expect(verdictOf(received, secret).ok).toBe(true);
    const ids = receiver.received.map((received) => parse(received).id);
    expect(new Set(ids).size).toBe(1);
  });

  // #500-T10
  it("delivers the newest event first when told to, and every delivery verifies", async () => {
    const { fake, receiver, secret, session } = await setup();
    fake.buyer.pay(session.id);
    await fake.flush({ order: "reversed" });
    expect(types(receiver.received)).toEqual([
      "checkout.session.completed",
      "charge.succeeded",
      "payment_intent.succeeded",
    ]);
    // The reordered deliveries still tell their own creation time, in order of the events.
    const created = receiver.received.map(
      (received) => parse(received).created,
    );
    expect(created).toEqual([...created].sort((a, b) => b - a));
    for (const received of receiver.received)
      expect(verdictOf(received, secret).ok).toBe(true);
  });

  // #500-T10
  it("delivers late: the event keeps the time it happened, the signature is made when it is sent", async () => {
    let clock = 1_700_000_000_000;
    const { fake, receiver, secret, session } = await setup({
      fakeOptions: { now: () => clock },
    });
    fake.buyer.pay(session.id);
    clock += 3_600_000;
    await fake.flush();
    const [first] = receiver.received;
    expect(first).toBeDefined();
    expect(parse(first as Received).created).toBe(1_700_000_000);
    const verdict = verdictOf(first as Received, secret, new Date(clock));
    expect(verdict).toEqual({ ok: true, timestamp: 1_700_003_600 });
    // The same delivery, looked at an hour after it was sent, is stale.
    expect(
      verdictOf(first as Received, secret, new Date(clock + 3_600_000)),
    ).toEqual({ ok: false, code: "timestamp_out_of_tolerance" });
  });

  // #500-T10
  it("waits before each delivery when told to", async () => {
    const waits: number[] = [];
    const { fake, session } = await setup({
      fakeOptions: {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
    });
    fake.buyer.pay(session.id);
    await fake.flush({ delayMs: 4000 });
    expect(waits).toEqual([4000, 4000, 4000]);
  });

  // #500-T10
  it.each([
    ["stale_timestamp", { ok: false, code: "timestamp_out_of_tolerance" }],
    ["bad_signature", { ok: false, code: "signature_mismatch" }],
    ["altered_body", { ok: false, code: "signature_mismatch" }],
    ["missing_signature", { ok: false, code: "signature_missing" }],
    ["malformed_signature", { ok: false, code: "signature_malformed" }],
  ] as const)(
    "sends a delivery with the fault %s that our verifier refuses with the right code",
    async (fault, expected) => {
      const { fake, receiver, secret, session } = await setup({
        events: ["checkout.session.completed"],
      });
      fake.buyer.pay(session.id);
      await fake.flush({ fault });
      expect(receiver.received).toHaveLength(1);
      expect(verdictOf(receiver.received[0] as Received, secret)).toEqual(
        expected,
      );
    },
  );

  // #500-T10
  it.each(["two_v1_valid_first", "two_v1_valid_last"] as const)(
    "sends two v1 signatures with the fault %s, one valid, and our verifier accepts them",
    async (fault) => {
      const { fake, receiver, secret, session } = await setup({
        events: ["checkout.session.completed"],
      });
      fake.buyer.pay(session.id);
      await fake.flush({ fault });
      const header = receiver.received[0]?.headers["stripe-signature"] ?? "";
      expect(header.match(/v1=/g)).toHaveLength(2);
      expect(verdictOf(receiver.received[0] as Received, secret).ok).toBe(true);
    },
  );

  // #500-T10
  it("signs with the secret of the endpoint, so another secret does not verify", async () => {
    const { fake, receiver, session } = await setup({
      events: ["checkout.session.completed"],
    });
    fake.buyer.pay(session.id);
    await fake.flush();
    expect(
      verdictOf(receiver.received[0] as Received, "whsec_some_other_secret"),
    ).toEqual({ ok: false, code: "signature_mismatch" });
  });

  // #500-T10
  it("sends only the event types an endpoint subscribed to, and nothing to a deleted endpoint", async () => {
    const { fake, client, receiver, endpoint, session } = await setup({
      events: ["charge.succeeded"],
    });
    fake.buyer.pay(session.id);
    await fake.flush();
    expect(types(receiver.received)).toEqual(["charge.succeeded"]);
    await client.deleteWebhookEndpoint(endpoint.id);
    const second = await client.createCheckoutSession(SESSION_INPUT, {
      idempotencyKey: uniqueIdempotencyKey(),
    });
    fake.buyer.pay(second.id);
    expect(await fake.flush()).toEqual([]);
    expect(receiver.received).toHaveLength(1);
  });

  // #500-T10
  it("delivers to every subscribed endpoint, each signed with its own secret", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    const a = await startReceiver();
    const b = await startReceiver();
    const first = await client.createWebhookEndpoint({
      url: a.url,
      enabled_events: ["*"],
    });
    const second = await client.createWebhookEndpoint({
      url: b.url,
      enabled_events: ["checkout.session.completed"],
    });
    expect(first.secret).not.toBe(second.secret);
    const session = await client.createCheckoutSession(SESSION_INPUT, {
      idempotencyKey: uniqueIdempotencyKey(),
    });
    fake.buyer.pay(session.id);
    await fake.flush();
    expect(a.received).toHaveLength(3);
    expect(b.received).toHaveLength(1);
    expect(verdictOf(a.received[0] as Received, first.secret ?? "").ok).toBe(
      true,
    );
    expect(verdictOf(b.received[0] as Received, second.secret ?? "").ok).toBe(
      true,
    );
    expect(verdictOf(b.received[0] as Received, first.secret ?? "").ok).toBe(
      false,
    );
  });

  // #500-T10
  it("keeps an event pending while the receiver answers with an error, and sends it again at the next flush", async () => {
    const { fake, receiver, session } = await setup({
      events: ["checkout.session.completed"],
    });
    fake.buyer.pay(session.id);
    receiver.answer.status = 500;
    const failed = await fake.flush();
    expect(failed.map((result) => result.status)).toEqual([500]);
    receiver.answer.status = 200;
    const retried = await fake.flush();
    expect(retried.map((result) => result.status)).toEqual([200]);
    expect(retried[0]?.attempt).toBe(2);
    expect(receiver.received).toHaveLength(2);
    expect(await fake.flush()).toEqual([]);
  });

  // #500-T10
  it("reports a receiver that cannot be reached with no status, without throwing", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    await client.createWebhookEndpoint({
      url: "http://127.0.0.1:9/nothing-listens",
      enabled_events: ["*"],
    });
    const session = await client.createCheckoutSession(SESSION_INPUT, {
      idempotencyKey: uniqueIdempotencyKey(),
    });
    fake.buyer.pay(session.id);
    const results = await fake.flush();
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.status === null)).toBe(true);
  });

  // #500-T10
  it("sends the events of a refund and a dispute the same way, and they verify", async () => {
    const { fake, receiver, secret, session } = await setup({
      events: ["charge.refunded", "refund.created", "charge.dispute.created"],
    });
    const paid = fake.buyer.pay(session.id);
    fake.stripe.refund({ charge: paid.charge.id, amount: 500 });
    fake.stripe.openDispute(paid.charge.id);
    await fake.flush();
    expect(types(receiver.received)).toEqual([
      "charge.refunded",
      "refund.created",
      "charge.dispute.created",
    ]);
    for (const received of receiver.received)
      expect(verdictOf(received, secret).ok).toBe(true);
  });

  // #500-T10
  it("can send chosen events again, as Stripe does when an operator resends one", async () => {
    const { fake, receiver, session } = await setup({
      events: ["checkout.session.completed"],
    });
    fake.buyer.pay(session.id);
    await fake.flush();
    const [event] = fake
      .events()
      .filter((e) => e.type === "checkout.session.completed");
    await fake.flush({ eventIds: [event?.id ?? ""] });
    expect(receiver.received).toHaveLength(2);
    expect(parse(receiver.received[0] as Received).id).toBe(
      parse(receiver.received[1] as Received).id,
    );
  });
});

describe("the fake as a process", () => {
  // #500-T11
  it("is controlled over HTTP under /__fake: health, the buyer, a refund, a dispute, a flush, the events and a reset", async () => {
    const { fake, receiver, secret, session } = await setup({
      events: ["checkout.session.completed", "charge.refunded"],
    });
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${fake.baseUrl}/__fake${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        json: (await response.json()) as Record<string, unknown>,
      };
    };
    expect((await fetch(`${fake.baseUrl}/__fake/health`)).status).toBe(200);
    const paid = await post("/pay", { session: session.id, tax_amount: 100 });
    expect(paid.status).toBe(200);
    expect(paid.json).toMatchObject({ session: session.id });
    const refunded = await post("/refund", {
      payment_intent: paid.json.payment_intent,
      amount: 500,
    });
    expect(refunded.status).toBe(200);
    const flushed = await post("/flush", {});
    expect(flushed.status).toBe(200);
    expect(types(receiver.received)).toEqual([
      "checkout.session.completed",
      "charge.refunded",
    ]);
    for (const received of receiver.received)
      expect(verdictOf(received, secret).ok).toBe(true);
    const events = (await (
      await fetch(`${fake.baseUrl}/__fake/events`)
    ).json()) as {
      data: Array<{ type: string }>;
    };
    expect(events.data.map((event) => event.type)).toContain("charge.refunded");
    expect((await post("/pay", { session: session.id })).status).toBe(400);
    expect((await post("/reset", {})).status).toBe(200);
    expect(fake.events()).toHaveLength(0);
    expect(fake.checkoutSessions()).toHaveLength(0);
  });
});

describe("the fake stays on this machine", () => {
  // #500-T18
  it("sends no event to an endpoint that is not on the loopback, and says so", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    const endpoints = await Promise.all(
      [
        "http://203.0.113.9:9/hook",
        "https://webhooks.example.test/hook",
        "http://127.0.0.1.example.test/hook",
      ].map((url) =>
        client.createWebhookEndpoint({ url, enabled_events: ["*"] }),
      ),
    );
    const session = await client.createCheckoutSession(SESSION_INPUT, {
      idempotencyKey: uniqueIdempotencyKey(),
    });
    fake.buyer.pay(session.id);
    const outgoing = vi.spyOn(globalThis, "fetch");
    try {
      const results = await fake.flush();
      expect(outgoing).not.toHaveBeenCalled();
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.status).toBeNull();
        expect(result.refused).toBe("not_loopback");
      }
      expect(new Set(results.map((r) => r.endpointId))).toEqual(
        new Set(endpoints.map((e) => e.id)),
      );
    } finally {
      outgoing.mockRestore();
    }
  });

  // #500-T18
  it("does not listen anywhere but on the loopback, as a library and as a process", async () => {
    for (const host of ["0.0.0.0", "::", "192.0.2.1", "example.test"])
      await expect(startStripeFake({ host }), host).rejects.toThrow(/loopback/);
    const fake = await startStripeFake({ host: "127.0.0.1" });
    try {
      expect(fake.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await fake.close();
    }
    const main = fileURLToPath(
      new URL("../../../fakes/stripe/main.ts", import.meta.url),
    );
    const refused = await promisify(execFile)(process.execPath, [main], {
      env: {
        ...process.env,
        STRIPE_FAKE_PORT: "1",
        STRIPE_FAKE_HOST: "0.0.0.0",
      },
      timeout: 20_000,
    }).then(
      () => null,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(refused?.code).toBe(1);
    expect(refused?.stderr).toMatch(/loopback/);
  });
});
