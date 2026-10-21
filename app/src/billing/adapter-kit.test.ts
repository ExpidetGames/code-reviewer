// SPDX-License-Identifier: Apache-2.0

// #497-T14: the adapter test kit runs for the manual adapter (no webhook) and for the fake adapter (with one).
import { describe, expect, it } from "vitest";
import {
  describeAdapterContract,
  type AdapterKitSubject,
} from "../test-support/billing-adapter-kit.ts";
import {
  FAKE_WEBHOOK_SECRET,
  createFakeBillingAdapter,
  fakeBodyBytes,
  fakeWebhookRequest,
  signFakeBody,
  type FakeWireEvent,
} from "../test-support/fake-billing-adapter.ts";
import { toProviderAmount, toUsd } from "./adapter.ts";
import { manualAdapter } from "./manual-adapter.ts";
import { signStripeWebhook } from "../../../fakes/stripe/server.ts";
import { createStripeClient } from "./stripe-client.ts";
import { createStripeAdapter } from "./stripe-adapter.ts";

const NOW = new Date("2026-10-19T08:00:00.000Z");
const T = "2026-10-19T08:00:00.000Z";
const USD = 1_000_000;

const payment: FakeWireEvent = {
  id: "evt_1",
  kind: "payment",
  created: T,
  intent: "intent-1",
  payment: "pi_1",
  checkout: "cs_1",
  net: 25 * USD,
  gross: 29_750_000,
  tax: 4_750_000,
};

const manual: AdapterKitSubject = {
  name: "manual",
  create: () => manualAdapter,
};

const fake: AdapterKitSubject = {
  name: "fake",
  create: () =>
    createFakeBillingAdapter({
      lookups: (intentId) => (intentId === "intent-1" ? payment : undefined),
    }),
  lookup: [
    {
      label: "a paid top-up",
      input: { intentId: "intent-1", checkout: null, payment: null },
      expected: {
        type: "payment.succeeded",
        eventId: "evt_1",
        occurredAt: T,
        intentId: "intent-1",
        payment: "pi_1",
        checkout: "cs_1",
        creditable: toUsd(25 * USD),
        gross: toUsd(29_750_000),
        tax: toUsd(4_750_000),
      },
    },
    {
      label: "a top-up the provider does not know",
      input: { intentId: "intent-unknown", checkout: null, payment: null },
      expected: null,
    },
  ],
  webhook: {
    now: NOW,
    valid: [
      {
        label: "a payment",
        request: fakeWebhookRequest(payment),
        expected: {
          type: "payment.succeeded",
          eventId: "evt_1",
          occurredAt: T,
          intentId: "intent-1",
          payment: "pi_1",
          checkout: "cs_1",
          creditable: toUsd(25 * USD),
          gross: toUsd(29_750_000),
          tax: toUsd(4_750_000),
        },
      },
      {
        label: "a refund by the provider",
        request: fakeWebhookRequest({
          id: "evt_2",
          kind: "refund",
          created: T,
          payment: "pi_1",
          refund: "re_1",
          amount: 5 * USD,
          payment_amount: 29_750_000,
          status: "approved",
        }),
        expected: {
          type: "refund.updated",
          eventId: "evt_2",
          occurredAt: T,
          payment: "pi_1",
          refund: "re_1",
          amount: toProviderAmount(5 * USD),
          paymentAmount: toProviderAmount(29_750_000),
          initiatedBy: "provider",
          status: "approved",
        },
      },
      {
        label: "a dispute lost",
        request: fakeWebhookRequest({
          id: "evt_3",
          kind: "dispute",
          created: T,
          payment: "pi_1",
          dispute: "dp_1",
          amount: 29_750_000,
          payment_amount: 29_750_000,
          status: "lost",
        }),
        expected: {
          type: "dispute.updated",
          eventId: "evt_3",
          occurredAt: T,
          payment: "pi_1",
          dispute: "dp_1",
          amount: toProviderAmount(29_750_000),
          paymentAmount: toProviderAmount(29_750_000),
          status: "lost",
        },
      },
      {
        label: "a failed payment",
        request: fakeWebhookRequest({
          id: "evt_4",
          kind: "payment_failed",
          created: T,
          intent: "intent-1",
        }),
        expected: {
          type: "payment.failed",
          eventId: "evt_4",
          occurredAt: T,
          intentId: "intent-1",
          payment: null,
          checkout: null,
        },
      },
      {
        label: "a checkout that expired",
        request: fakeWebhookRequest({
          id: "evt_6",
          kind: "payment_expired",
          created: T,
          intent: "intent-1",
          checkout: "cs_1",
        }),
        expected: {
          type: "payment.expired",
          eventId: "evt_6",
          occurredAt: T,
          intentId: "intent-1",
          payment: null,
          checkout: "cs_1",
        },
      },
      {
        label: "an event of a type nobody uses",
        request: fakeWebhookRequest({ id: "evt_5", kind: "other", created: T }),
        expected: { type: "ignored", eventId: "evt_5", occurredAt: T },
      },
    ],
    rejected: [
      {
        label: "no signature",
        request: {
          rawBody: fakeBodyBytes(JSON.stringify(payment)),
          headers: new Headers(),
        },
        code: "signature_missing",
      },
      {
        label: "an empty signature",
        request: {
          rawBody: fakeBodyBytes(JSON.stringify(payment)),
          headers: new Headers({ "x-fake-signature": "" }),
        },
        code: "signature_missing",
      },
      {
        label: "another secret",
        request: fakeWebhookRequest(payment, "another-secret"),
        code: "signature_invalid",
      },
      {
        label: "an altered body",
        request: {
          rawBody: fakeBodyBytes(
            JSON.stringify({ ...payment, net: 500 * USD }),
          ),
          headers: new Headers({
            "x-fake-signature": signFakeBody(JSON.stringify(payment)),
          }),
        },
        code: "signature_invalid",
      },
      {
        label: "a signature that is not hex",
        request: {
          rawBody: fakeBodyBytes(JSON.stringify(payment)),
          headers: new Headers({ "x-fake-signature": "zz" }),
        },
        code: "signature_invalid",
      },
      {
        label: "a signed body that is not JSON",
        request: fakeWebhookRequest("not json"),
        code: "body_invalid",
      },
      {
        label: "a signed body of an unknown kind",
        request: fakeWebhookRequest(
          JSON.stringify({ id: "evt_9", kind: "mystery", created: T }),
        ),
        code: "body_invalid",
      },
    ],
  },
};

// #501, #502: the Stripe adapter, with its webhook (signed the way Stripe signs, with the scheme of the fake) and its lookup.
// A client whose `fetch` answers from a small table of sessions stands in for Stripe; no network is used.
const STRIPE_SECRET = "whsec_KitSecretValueForTheAdapterKit00";
const SECONDS = Math.floor(NOW.getTime() / 1000);

const kitSession = (overrides: Record<string, unknown> = {}) => ({
  id: "cs_test_KitPaid0001",
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  url: null,
  customer: "cus_Kit0001",
  payment_intent: "pi_1",
  client_reference_id: "intent-1",
  metadata: { intent: "intent-1" },
  amount_subtotal: 2500,
  amount_total: 2975,
  total_details: { amount_tax: 475 },
  currency: "usd",
  expires_at: SECONDS + 3600,
  created: SECONDS - 60,
  livemode: false,
  ...overrides,
});

function stripeFetch(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  if (method === "POST")
    return Promise.resolve(
      Response.json(
        kitSession({
          id: "cs_test_Kit0001",
          status: "open",
          payment_status: "unpaid",
          payment_intent: null,
          url: "https://checkout.example.test/c/pay/cs_test_Kit0001",
        }),
      ),
    );
  if (url.pathname.endsWith("/cs_test_KitPaid0001"))
    return Promise.resolve(Response.json(kitSession()));
  return Promise.resolve(
    Response.json(
      { error: { type: "invalid_request_error", code: "resource_missing" } },
      { status: 404 },
    ),
  );
}

function stripeRequest(
  event: Record<string, unknown>,
  { secret = STRIPE_SECRET, seconds = SECONDS } = {},
) {
  const body = JSON.stringify(event);
  return {
    headers: new Headers({
      "stripe-signature": signStripeWebhook(body, secret, seconds),
    }),
    rawBody: new TextEncoder().encode(body),
  };
}

const stripeEvent = (
  id: string,
  type: string,
  object: Record<string, unknown>,
) => ({
  id,
  object: "event",
  api_version: "2025-03-31.basil",
  created: SECONDS,
  livemode: false,
  type,
  data: { object },
});

const stripePaid = stripeEvent(
  "evt_1",
  "checkout.session.completed",
  kitSession(),
);

const stripe: AdapterKitSubject = {
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
  lookup: [
    {
      label: "a paid top-up",
      input: {
        intentId: "intent-1",
        checkout: "cs_test_KitPaid0001",
        payment: null,
      },
      expected: {
        type: "payment.succeeded",
        eventId: "check-cs_test_KitPaid0001-paid",
        occurredAt: T,
        intentId: "intent-1",
        payment: "pi_1",
        checkout: "cs_test_KitPaid0001",
        creditable: toUsd(25 * USD),
        gross: toUsd(29_750_000),
        tax: toUsd(4_750_000),
        providerAmount: toProviderAmount(2975),
        providerCurrency: "usd",
      },
    },
    {
      label: "a top-up for another intent than the session names",
      input: {
        intentId: "intent-other",
        checkout: "cs_test_KitPaid0001",
        payment: null,
      },
      expected: null,
    },
    {
      label: "a top-up Stripe does not know",
      input: { intentId: "intent-1", checkout: "cs_test_gone", payment: null },
      expected: null,
    },
    {
      label: "a top-up with no page",
      input: { intentId: "intent-1", checkout: null, payment: null },
      expected: null,
    },
  ],
  webhook: {
    now: NOW,
    valid: [
      {
        label: "a paid session",
        request: stripeRequest(stripePaid),
        expected: {
          type: "payment.succeeded",
          eventId: "evt_1",
          occurredAt: T,
          intentId: "intent-1",
          payment: "pi_1",
          checkout: "cs_test_KitPaid0001",
          creditable: toUsd(25 * USD),
          gross: toUsd(29_750_000),
          tax: toUsd(4_750_000),
          providerAmount: toProviderAmount(2975),
          providerCurrency: "usd",
        },
      },
      {
        label: "a refund",
        request: stripeRequest(
          stripeEvent("evt_2", "refund.created", {
            id: "re_1",
            object: "refund",
            amount: 1000,
            currency: "usd",
            charge: "ch_1",
            payment_intent: "pi_1",
            status: "succeeded",
            reason: "requested_by_customer",
            metadata: {},
            created: SECONDS,
          }),
        ),
        expected: {
          type: "refund.updated",
          eventId: "evt_2",
          occurredAt: T,
          payment: "pi_1",
          refund: "re_1",
          amount: toProviderAmount(1000),
          currency: "usd",
          initiatedBy: "customer",
          status: "approved",
        },
      },
      {
        label: "a dispute lost",
        request: stripeRequest(
          stripeEvent("evt_3", "charge.dispute.closed", {
            id: "dp_1",
            object: "dispute",
            amount: 2975,
            currency: "usd",
            charge: "ch_1",
            payment_intent: "pi_1",
            status: "lost",
            created: SECONDS,
          }),
        ),
        expected: {
          type: "dispute.updated",
          eventId: "evt_3",
          occurredAt: T,
          payment: "pi_1",
          dispute: "dp_1",
          amount: toProviderAmount(2975),
          currency: "usd",
          status: "lost",
        },
      },
      {
        label: "an asynchronous failure",
        request: stripeRequest(
          stripeEvent(
            "evt_4",
            "checkout.session.async_payment_failed",
            kitSession({ payment_status: "unpaid" }),
          ),
        ),
        expected: {
          type: "payment.failed",
          eventId: "evt_4",
          occurredAt: T,
          intentId: "intent-1",
          payment: "pi_1",
          checkout: "cs_test_KitPaid0001",
        },
      },
      {
        label: "a session that expired",
        request: stripeRequest(
          stripeEvent(
            "evt_6",
            "checkout.session.expired",
            kitSession({
              status: "expired",
              payment_status: "unpaid",
              payment_intent: null,
            }),
          ),
        ),
        expected: {
          type: "payment.expired",
          eventId: "evt_6",
          occurredAt: T,
          intentId: "intent-1",
          payment: null,
          checkout: "cs_test_KitPaid0001",
        },
      },
      {
        label: "an event of a type nobody uses",
        request: stripeRequest(stripeEvent("evt_5", "customer.created", {})),
        expected: { type: "ignored", eventId: "evt_5", occurredAt: T },
      },
    ],
    rejected: [
      {
        label: "no signature",
        request: {
          rawBody: stripeRequest(stripePaid).rawBody,
          headers: new Headers(),
        },
        code: "signature_missing",
      },
      {
        label: "another secret",
        request: stripeRequest(stripePaid, {
          secret: "whsec_another_secret_00",
        }),
        code: "signature_invalid",
      },
      {
        label: "an altered body",
        request: {
          rawBody: new TextEncoder().encode(`${JSON.stringify(stripePaid)} `),
          headers: stripeRequest(stripePaid).headers,
        },
        code: "signature_invalid",
      },
      {
        label: "a signature that is not hex",
        request: {
          rawBody: stripeRequest(stripePaid).rawBody,
          headers: new Headers({ "stripe-signature": `t=${SECONDS},v1=zz` }),
        },
        code: "signature_invalid",
      },
      {
        label: "an old timestamp",
        request: stripeRequest(stripePaid, { seconds: SECONDS - 3600 }),
        code: "signature_expired",
      },
      {
        label: "a signed body that is not JSON",
        request: (() => {
          const rawBody = new TextEncoder().encode("not json");
          return {
            rawBody,
            headers: new Headers({
              "stripe-signature": signStripeWebhook(
                Buffer.from(rawBody),
                STRIPE_SECRET,
                SECONDS,
              ),
            }),
          };
        })(),
        code: "body_invalid",
      },
    ],
  },
};

for (const subject of [manual, fake, stripe]) describeAdapterContract(subject);

describe("the kit", () => {
  // #497-T14
  it("holds the fake adapter to the secret it was made with", async () => {
    const adapter = createFakeBillingAdapter({ secret: "mine" });
    const ok = await adapter.verifyAndParseWebhook?.({
      ...fakeWebhookRequest(payment, "mine"),
      now: NOW,
    });
    const wrong = await adapter.verifyAndParseWebhook?.({
      ...fakeWebhookRequest(payment),
      now: NOW,
    });

    expect(ok?.ok).toBe(true);
    expect(wrong).toEqual({ ok: false, code: "signature_invalid" });
    expect(FAKE_WEBHOOK_SECRET).not.toBe("mine");
  });
});
