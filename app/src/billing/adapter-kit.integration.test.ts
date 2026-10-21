// SPDX-License-Identifier: Apache-2.0

// #497-T14: the application half of the adapter test kit, for the fake adapter, on every engine. (The manual adapter has
// no webhook, so it has no events to apply; its credits are tested in manual-credit.integration.test.ts.)
import { signStripeWebhook } from "../../../fakes/stripe/server.ts";
import { createStripeAdapter } from "./stripe-adapter.ts";
import { createStripeClient } from "./stripe-client.ts";
import { BILLING_ENGINES } from "../test-support/billing-engines.ts";
import { describeAdapterApplication } from "../test-support/billing-adapter-kit.ts";
import {
  createFakeBillingAdapter,
  fakeWebhookRequest,
  type FakeWireEvent,
} from "../test-support/fake-billing-adapter.ts";

const NOW = new Date("2026-10-19T08:00:00.000Z");
let counter = 0;
const lookups = new Map<string, FakeWireEvent>();

describeAdapterApplication(
  {
    name: "fake",
    create: () =>
      createFakeBillingAdapter({
        lookups: (intentId) => lookups.get(intentId),
      }),
    now: NOW,
    fixtures: ({ intentId, amount }) => {
      counter += 1;
      const payment = `pi_kit_${counter}`;
      const created = NOW.toISOString();
      const wire = (id: string): FakeWireEvent => ({
        id: `${id}_${counter}`,
        kind: "payment",
        created,
        intent: intentId,
        payment,
        checkout: `cs_kit_${counter}`,
        net: amount,
        gross: amount + 4_000_000,
        tax: 4_000_000,
      });
      const paid = (id: string) => fakeWebhookRequest(wire(id));
      lookups.set(intentId, wire("evt_lookup"));
      const refundAmount = 5_000_000;
      return {
        paid: paid("evt_completed"),
        // Another delivery of the same payment under another event id.
        paidAgain: paid("evt_succeeded"),
        refunded: fakeWebhookRequest({
          id: `evt_refund_${counter}`,
          kind: "refund",
          created: new Date(NOW.getTime() + 60_000).toISOString(),
          payment,
          refund: `re_kit_${counter}`,
          // Net 25 of a gross 29: a share of 5 net is 5.8 of the gross.
          amount: 5_800_000,
          payment_amount: amount + 4_000_000,
          status: "approved",
        }),
        refundAmount,
      };
    },
  },
  BILLING_ENGINES,
);

// #502: the same kit for the Stripe adapter. A client whose `fetch` answers from a table of the sessions the fixtures make
// stands in for Stripe; the events are signed the way Stripe signs.
const STRIPE_SECRET = "whsec_KitSecretForTheStripeApplication0";
const SECONDS = Math.floor(NOW.getTime() / 1000);
const sessions = new Map<string, Record<string, unknown>>();

const stripeFetch = (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const session = sessions.get(url.pathname.split("/").at(-1) ?? "");
  return Promise.resolve(
    session === undefined
      ? Response.json(
          {
            error: { type: "invalid_request_error", code: "resource_missing" },
          },
          { status: 404 },
        )
      : Response.json(session),
  );
};

const stripeRequest = (event: Record<string, unknown>) => {
  const body = JSON.stringify(event);
  return {
    headers: new Headers({
      "stripe-signature": signStripeWebhook(body, STRIPE_SECRET, SECONDS),
    }),
    rawBody: new TextEncoder().encode(body),
  };
};

describeAdapterApplication(
  {
    name: "stripe",
    create: () =>
      createStripeAdapter({
        client: () =>
          Promise.resolve(
            createStripeClient({
              apiKey: "sk_test_dummyvalue_for_unit_tests_0001",
              baseUrl: "https://stripe.invalid",
              fetch: stripeFetch,
            }),
          ),
        webhookSecret: () => Promise.resolve(STRIPE_SECRET),
        environment: () => Promise.resolve("test"),
        now: () => NOW,
      }),
    now: NOW,
    fixtures: ({ intentId, amount }) => {
      counter += 1;
      const payment = `pi_kit_stripe_${counter}`;
      const checkout = `cs_test_kit_${counter}`;
      const net = amount / 10_000;
      const session = {
        id: checkout,
        object: "checkout.session",
        status: "complete",
        payment_status: "paid",
        mode: "payment",
        url: null,
        customer: "cus_kit",
        payment_intent: payment,
        client_reference_id: intentId,
        metadata: { intent: intentId },
        amount_subtotal: net,
        amount_total: net + 400,
        total_details: { amount_tax: 400 },
        currency: "usd",
        expires_at: SECONDS + 3600,
        created: SECONDS - 60,
        livemode: false,
      };
      sessions.set(checkout, session);
      const event = (id: string, type: string, object: unknown) =>
        stripeRequest({
          id: `${id}_${counter}`,
          object: "event",
          created: SECONDS,
          livemode: false,
          type,
          data: { object },
        });
      return {
        paid: event("evt_completed", "checkout.session.completed", session),
        // Another delivery of the same payment under another event id (a delayed method that succeeds later).
        paidAgain: event(
          "evt_async",
          "checkout.session.async_payment_succeeded",
          session,
        ),
        refunded: event("evt_refund", "refund.created", {
          id: `re_kit_${counter}`,
          object: "refund",
          // 20 percent of the charge: 20 percent of the 25 USD credit.
          amount: (net + 400) / 5,
          currency: "usd",
          charge: `ch_kit_${counter}`,
          payment_intent: payment,
          status: "succeeded",
          reason: null,
          metadata: {},
          created: SECONDS + 60,
        }),
        refundAmount: (amount * 1) / 5,
        lookupRefs: { checkout, payment: null },
      };
    },
  },
  BILLING_ENGINES,
);
