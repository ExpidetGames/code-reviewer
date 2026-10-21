// SPDX-License-Identifier: Apache-2.0

// #502: what a verified Stripe event becomes. Pure: a parsed JSON value and the environment of the stored key come in, a
// normalized event (or a refusal to read the body) comes out. Nothing is asked of Stripe and nothing is stored.
import { describe, expect, it } from "vitest";
import {
  parseStripeWebhookEvent,
  type StripeParseResult,
} from "./stripe-webhook-parse.ts";

const USD = 1_000_000;
const CREATED = 1_790_000_000;
const OCCURRED_AT = new Date(CREATED * 1000).toISOString();

type Json = Record<string, unknown>;

function session(overrides: Json = {}): Json {
  return {
    id: "cs_test_1",
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    url: null,
    customer: "cus_1",
    payment_intent: "pi_1",
    client_reference_id: "intent-1",
    metadata: { intent: "intent-1" },
    amount_subtotal: 2500,
    amount_total: 2975,
    total_details: { amount_tax: 475, amount_discount: 0, amount_shipping: 0 },
    currency: "usd",
    expires_at: CREATED + 3600,
    created: CREATED - 60,
    livemode: false,
    ...overrides,
  };
}

function refundObject(overrides: Json = {}): Json {
  return {
    id: "re_1",
    object: "refund",
    amount: 1000,
    currency: "usd",
    charge: "ch_1",
    payment_intent: "pi_1",
    status: "succeeded",
    reason: null,
    metadata: {},
    created: CREATED - 5,
    ...overrides,
  };
}

function disputeObject(overrides: Json = {}): Json {
  return {
    id: "dp_1",
    object: "dispute",
    amount: 2975,
    currency: "usd",
    charge: "ch_1",
    payment_intent: "pi_1",
    status: "needs_response",
    livemode: false,
    created: CREATED - 5,
    metadata: {},
    ...overrides,
  };
}

function envelope(type: string, object: Json, overrides: Json = {}): Json {
  return {
    id: `evt_${type}`,
    object: "event",
    api_version: "2025-03-31.basil",
    created: CREATED,
    livemode: false,
    type,
    data: { object },
    ...overrides,
  };
}

const parse = (event: unknown, environment: "test" | "live" = "test") =>
  parseStripeWebhookEvent(event, { environment });

function eventOf(result: StripeParseResult) {
  if (!result.ok) throw new Error("expected an event");
  return result.event;
}

describe("payments", () => {
  // #502-T01
  it("turns a paid session into a payment of the net amount, with the gross, the tax and the references", () => {
    const event = eventOf(
      parse(envelope("checkout.session.completed", session())),
    );

    expect(event).toEqual({
      type: "payment.succeeded",
      eventId: "evt_checkout.session.completed",
      occurredAt: OCCURRED_AT,
      intentId: "intent-1",
      payment: "pi_1",
      checkout: "cs_test_1",
      creditable: 25 * USD,
      gross: 29_750_000,
      tax: 4_750_000,
      providerAmount: 2975,
      providerCurrency: "usd",
    });
  });

  // #502-T01
  it("reads the amount the buyer was charged from the presentment details when the buyer paid in another currency", () => {
    const event = eventOf(
      parse(
        envelope(
          "checkout.session.completed",
          session({
            presentment_details: {
              presentment_amount: 2700,
              presentment_currency: "eur",
            },
          }),
        ),
      ),
    );

    expect(event).toMatchObject({
      type: "payment.succeeded",
      creditable: 25 * USD,
      providerAmount: 2700,
      providerCurrency: "eur",
    });
  });

  // #502-T16
  it("names the currency the buyer was charged in: the session's own without presentment details, the presented one with them", () => {
    const own = eventOf(
      parse(envelope("checkout.session.completed", session())),
    );
    const presented = eventOf(
      parse(
        envelope(
          "checkout.session.completed",
          session({
            presentment_details: {
              presentment_amount: 2200,
              presentment_currency: "EUR",
            },
          }),
        ),
      ),
    );

    expect(own).toMatchObject({ providerCurrency: "usd" });
    expect(presented).toMatchObject({ providerCurrency: "eur" });
  });

  // #502-T17
  it("credits what the buyer paid net of tax, after a discount: the total less the tax, not the subtotal", () => {
    // Subtotal 25.00, discount 2.50, tax 5.00 on top: the buyer paid 27.50 and 22.50 of it is ours.
    const event = eventOf(
      parse(
        envelope(
          "checkout.session.completed",
          session({
            amount_subtotal: 2500,
            amount_total: 2750,
            total_details: {
              amount_tax: 500,
              amount_discount: 250,
              amount_shipping: 0,
            },
          }),
        ),
      ),
    );

    expect(event).toMatchObject({
      type: "payment.succeeded",
      creditable: 22_500_000,
      gross: 27_500_000,
      tax: 5_000_000,
      providerAmount: 2750,
    });
  });

  // #502-T17
  it("credits the total of a discounted session that has no tax", () => {
    const event = eventOf(
      parse(
        envelope(
          "checkout.session.completed",
          session({
            amount_subtotal: 2500,
            amount_total: 2250,
            total_details: {
              amount_tax: 0,
              amount_discount: 250,
              amount_shipping: 0,
            },
          }),
        ),
      ),
    );

    expect(event).toMatchObject({
      type: "payment.succeeded",
      creditable: 22_500_000,
      tax: 0,
    });
  });

  // #502-T01
  it("credits the asynchronous success the same way and waits for it when the completed session is unpaid", () => {
    const succeeded = eventOf(
      parse(
        envelope(
          "checkout.session.async_payment_succeeded",
          session({ payment_status: "paid" }),
        ),
      ),
    );
    const waiting = eventOf(
      parse(
        envelope(
          "checkout.session.completed",
          session({ payment_status: "unpaid" }),
        ),
      ),
    );

    expect(succeeded).toMatchObject({
      type: "payment.succeeded",
      creditable: 25 * USD,
    });
    expect(waiting.type).toBe("ignored");
  });

  // #502-T03
  it("maps an asynchronous failure and an expired session to the end of the payment", () => {
    const failed = eventOf(
      parse(
        envelope(
          "checkout.session.async_payment_failed",
          session({ payment_status: "unpaid" }),
        ),
      ),
    );
    const expired = eventOf(
      parse(
        envelope(
          "checkout.session.expired",
          session({
            status: "expired",
            payment_status: "unpaid",
            payment_intent: null,
          }),
        ),
      ),
    );

    expect(failed).toMatchObject({
      type: "payment.failed",
      intentId: "intent-1",
      payment: "pi_1",
      checkout: "cs_test_1",
    });
    expect(expired).toMatchObject({
      type: "payment.expired",
      intentId: "intent-1",
      payment: null,
      checkout: "cs_test_1",
    });
  });

  // #502-T09
  it("leaves a session of another mode alone", () => {
    const event = eventOf(
      parse(envelope("checkout.session.completed", session({ mode: "setup" }))),
    );

    expect(event.type).toBe("ignored");
  });

  // #502-T09
  it.each([
    ["another currency", { currency: "eur" }],
    ["the other environment", { livemode: true }],
    ["a reference that contradicts the metadata", { client_reference_id: "x" }],
    ["no total", { amount_total: null }],
    ["no tax figure", { total_details: null }],
    [
      "a net amount of zero",
      { amount_total: 475, total_details: { amount_tax: 475 } },
    ],
    ["a tax above the total", { amount_total: 400 }],
    ["a fractional amount", { amount_total: 2975.5 }],
    [
      "a presented currency that is no currency",
      {
        presentment_details: {
          presentment_amount: 2200,
          presentment_currency: "",
        },
      },
    ],
    ["no payment intent", { payment_intent: null }],
  ])("refuses to credit a paid session with %s", (_name, overrides) => {
    const event = eventOf(
      parse(envelope("checkout.session.completed", session(overrides))),
    );

    expect(event).toMatchObject({ type: "payment.refused" });
  });

  // #502-T09
  it("takes the intent from the metadata when the reference is missing, and from neither when both are", () => {
    const fromMetadata = eventOf(
      parse(
        envelope(
          "checkout.session.completed",
          session({ client_reference_id: null }),
        ),
      ),
    );
    const neither = eventOf(
      parse(
        envelope(
          "checkout.session.completed",
          session({ client_reference_id: null, metadata: {} }),
        ),
      ),
    );

    expect(fromMetadata).toMatchObject({ intentId: "intent-1" });
    expect(neither).toMatchObject({
      type: "payment.succeeded",
      intentId: null,
    });
  });
});

describe("refunds", () => {
  // #502-T05
  it.each([
    ["pending", "pending"],
    ["requires_action", "pending"],
    ["succeeded", "approved"],
    ["failed", "rejected"],
    ["canceled", "rejected"],
    [null, "pending"],
  ])("maps the Stripe refund status %s to %s", (stripe, ours) => {
    const event = eventOf(
      parse(envelope("refund.updated", refundObject({ status: stripe }))),
    );

    expect(event).toMatchObject({
      type: "refund.updated",
      payment: "pi_1",
      refund: "re_1",
      amount: 1000,
      currency: "usd",
      status: ours,
      occurredAt: OCCURRED_AT,
    });
  });

  // #502-T16
  it("carries the currency of the refund, in lower case", () => {
    const event = eventOf(
      parse(envelope("refund.created", refundObject({ currency: "EUR" }))),
    );

    expect(event).toMatchObject({ type: "refund.updated", currency: "eur" });
  });

  // #502-T08
  it("carries the amount of this refund only and no total of the payment", () => {
    const event = eventOf(parse(envelope("refund.created", refundObject())));

    expect(event).not.toHaveProperty("paymentAmount");
  });

  // #502-T05
  it.each([
    [{ reason: "requested_by_customer" }, "customer"],
    [{ reason: "expired_uncaptured_charge" }, "provider"],
    [{ reason: "fraudulent" }, "provider"],
    [{ reason: null }, "provider"],
    [{ reason: "duplicate", metadata: { source: "code-reviewer" } }, "seller"],
  ])("says who started a refund (%j: %s)", (overrides, initiatedBy) => {
    const event = eventOf(
      parse(envelope("refund.created", refundObject(overrides))),
    );

    expect(event).toMatchObject({ initiatedBy });
  });

  // #502-T09
  it("cannot place a refund that names no payment intent", () => {
    const result = parse(
      envelope("refund.created", refundObject({ payment_intent: null })),
    );

    expect(result).toEqual({ ok: false });
  });

  // #502-T09
  it("does not read the cumulative charge.refunded event as a refund", () => {
    const event = eventOf(
      parse(
        envelope("charge.refunded", {
          id: "ch_1",
          object: "charge",
          amount: 2975,
          amount_refunded: 2975,
          currency: "usd",
          payment_intent: "pi_1",
        }),
      ),
    );

    expect(event.type).toBe("ignored");
  });
});

describe("disputes", () => {
  it.each([
    ["charge.dispute.created", { status: "needs_response" }, "opened"],
    ["charge.dispute.funds_withdrawn", { status: "needs_response" }, "opened"],
    ["charge.dispute.closed", { status: "lost" }, "lost"],
    ["charge.dispute.closed", { status: "won" }, "won"],
    ["charge.dispute.closed", { status: "charge_refunded" }, "won"],
    ["charge.dispute.funds_reinstated", { status: "won" }, "won"],
  ])("maps %s with %j to %s", (type, overrides, status) => {
    // #502-T07
    const event = eventOf(parse(envelope(type, disputeObject(overrides))));

    expect(event).toMatchObject({
      type: "dispute.updated",
      payment: "pi_1",
      dispute: "dp_1",
      amount: 2975,
      currency: "usd",
      status,
    });
    expect(event).not.toHaveProperty("paymentAmount");
  });

  // #502-T16
  it("carries the currency of the dispute, in lower case", () => {
    const event = eventOf(
      parse(
        envelope("charge.dispute.created", disputeObject({ currency: "EUR" })),
      ),
    );

    expect(event).toMatchObject({ type: "dispute.updated", currency: "eur" });
  });

  // #502-T07
  it.each([
    ["charge.dispute.created", { status: "warning_needs_response" }],
    ["charge.dispute.closed", { status: "warning_closed" }],
    ["charge.dispute.updated", { status: "under_review" }],
  ])("moves no money for %s with %j", (type, overrides) => {
    const event = eventOf(parse(envelope(type, disputeObject(overrides))));

    expect(event.type).toBe("ignored");
  });
});

describe("what is not an event of ours", () => {
  // #502-T09
  it.each([
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "charge.succeeded",
    "customer.created",
    "invoice.paid",
    "something.new",
  ])("records %s as a type we do not use", (type) => {
    const event = eventOf(parse(envelope(type, { id: "x_1" })));

    expect(event).toMatchObject({
      type: "ignored",
      eventId: `evt_${type}`,
      occurredAt: OCCURRED_AT,
    });
  });

  // #502-T09
  it.each([
    ["not an object", "text"],
    ["an array", []],
    ["no id", { type: "refund.created", created: CREATED, livemode: false }],
    [
      "an id that is no opaque id",
      envelope("refund.created", {}, { id: "a b" }),
    ],
    ["no time", envelope("refund.created", refundObject(), { created: null })],
    ["no type", envelope("refund.created", {}, { type: 5 })],
    [
      "a refund of a shape we cannot read",
      envelope("refund.created", { id: "re_1", amount: "10" }),
    ],
    [
      "a session of a shape we cannot read",
      envelope("checkout.session.completed", { id: "cs_1" }),
    ],
  ])("refuses a body that is %s", (_name, body) => {
    expect(parse(body)).toEqual({ ok: false });
  });

  // #502-T09
  it("refuses an event of the other environment, whatever it is", () => {
    expect(
      parse(
        envelope("checkout.session.completed", session(), { livemode: true }),
      ),
    ).toEqual({ ok: false });
    expect(
      parse(
        envelope("checkout.session.completed", session({ livemode: true }), {
          livemode: true,
        }),
        "test",
      ),
    ).toEqual({ ok: false });
    expect(
      parse(envelope("customer.created", {}, { livemode: false }), "live"),
    ).toEqual({ ok: false });
  });
});
