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
import { manualAdapter } from "./manual-adapter.ts";

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
        creditable: 25 * USD,
        gross: 29_750_000,
        tax: 4_750_000,
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
          creditable: 25 * USD,
          gross: 29_750_000,
          tax: 4_750_000,
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
          amount: 5 * USD,
          paymentAmount: 29_750_000,
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
          amount: 29_750_000,
          paymentAmount: 29_750_000,
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

for (const subject of [manual, fake]) describeAdapterContract(subject);

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
