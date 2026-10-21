// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assertValidCapabilities,
  BillingAdapterError,
  toUsd,
  type BillingAdapter,
} from "./adapter.ts";
import { createStripeClient, StripeClientError } from "./stripe-client.ts";
import {
  STRIPE_CHECKOUT_PARAMETERS,
  STRIPE_TOP_UP_TAX_CODE,
  createStripeAdapter,
  topUpCheckoutKey,
} from "./stripe-adapter.ts";

const USD = 1_000_000;
const API_KEY = "sk_test_dummyvalue_for_unit_tests_0001";
const SESSION = {
  id: "cs_test_Fake0001",
  object: "checkout.session",
  status: "open",
  payment_status: "unpaid",
  mode: "payment",
  url: "https://checkout.example.test/c/pay/cs_test_Fake0001",
  customer: "cus_Fake0001",
  payment_intent: null,
  client_reference_id: "intent-1",
  metadata: { intent: "intent-1" },
  amount_total: 2500,
  amount_subtotal: 2500,
  currency: "usd",
  expires_at: 1_700_086_400,
  created: 1_700_000_000,
  livemode: false,
};

type Call = { url: string; init: RequestInit };

/** An adapter over a real client whose fetch answers from `reply`, and the calls it received. */
function stubbed(
  reply: (call: Call) => Response | Promise<Response> = () =>
    Response.json(SESSION),
) {
  const calls: Call[] = [];
  const adapter = createStripeAdapter({
    client: () =>
      Promise.resolve(
        createStripeClient({
          apiKey: API_KEY,
          baseUrl: "https://stripe.invalid",
          fetch: async (url, init) => {
            const call = { url, init };
            calls.push(call);
            return reply(call);
          },
          sleep: () => Promise.resolve(),
        }),
      ),
  });
  return { adapter, calls };
}

const bodyOf = (call: Call) => new URLSearchParams(String(call.init.body));
const headerOf = (call: Call, name: string) =>
  new Headers(call.init.headers).get(name);

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof BillingAdapterError ? error.code : "other";
  }
  return "none";
}

const TOP_UP = {
  customer: "cus_Fake0001",
  intentId: "intent-1",
  amount: toUsd(25 * USD),
  returnUrl: "https://app.example.test/w/acme/billing",
};

describe("the Stripe adapter", () => {
  // #501-T01
  it("declares Managed Payments: the seller of record, a custom amount from 10 to 500 USD, and a profile first", () => {
    const { adapter } = stubbed();

    expect(adapter.id).toBe("stripe");
    expect(adapter.capabilities).toEqual({
      merchantOfRecord: true,
      customAmount: true,
      partialRefund: true,
      minTopUp: 10 * USD,
      maxTopUp: 500 * USD,
      currencies: ["usd"],
      providerMayRefund: { windowDays: 60 },
      checkout: true,
      requiresBillingProfile: true,
      receiptsFrom: "provider",
    });
    expect(() =>
      assertValidCapabilities(adapter.id, adapter.capabilities),
    ).not.toThrow();
  });

  // #501-T05
  it("sends exactly the allowed set of parameters, and none that Managed Payments refuses", async () => {
    const { adapter, calls } = stubbed();

    await adapter.createTopUpCheckout(TOP_UP);

    expect(calls).toHaveLength(1);
    const names = [...bodyOf(calls[0] as Call).keys()];
    const topLevel = [...new Set(names.map((name) => name.split("[")[0]))];
    expect(topLevel.sort()).toEqual([...STRIPE_CHECKOUT_PARAMETERS].sort());
    for (const refused of [
      "tax_id_collection",
      "invoice_creation",
      "customer_update",
      "payment_method_types",
      "custom_text",
      "automatic_tax",
      "billing_address_collection",
      "shipping_address_collection",
    ])
      expect(topLevel).not.toContain(refused);
  });

  // #501-T01
  it("asks for one line of 'Review credit' in USD cents, tax exclusive, with the product tax code, in Managed Payments mode", async () => {
    const { adapter, calls } = stubbed();

    const started = await adapter.createTopUpCheckout(TOP_UP);

    const call = calls[0] as Call;
    expect(call.url).toBe("https://stripe.invalid/v1/checkout/sessions");
    expect(Object.fromEntries(bodyOf(call))).toEqual({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "2500",
      "line_items[0][price_data][tax_behavior]": "exclusive",
      "line_items[0][price_data][product_data][name]": "Review credit",
      "line_items[0][price_data][product_data][tax_code]":
        STRIPE_TOP_UP_TAX_CODE,
      "managed_payments[enabled]": "true",
      customer: "cus_Fake0001",
      client_reference_id: "intent-1",
      "metadata[intent]": "intent-1",
      success_url: "https://app.example.test/w/acme/billing?topup=success",
      cancel_url: "https://app.example.test/w/acme/billing?topup=cancelled",
    });
    expect(headerOf(call, "stripe-version")).toContain(
      "managed_payments_preview=v1",
    );
    expect(started).toEqual({
      checkout: {
        kind: "redirect",
        url: "https://checkout.example.test/c/pay/cs_test_Fake0001",
      },
      session: "cs_test_Fake0001",
      payment: null,
    });
    expect(STRIPE_TOP_UP_TAX_CODE).toBe("txcd_10105002");
  });

  // #501-T06
  it("derives the idempotency key of the checkout from the intent, so the same intent is the same session and another is not", async () => {
    const { adapter, calls } = stubbed();

    await adapter.createTopUpCheckout(TOP_UP);
    await adapter.createTopUpCheckout(TOP_UP);
    await adapter.createTopUpCheckout({ ...TOP_UP, intentId: "intent-2" });

    expect(headerOf(calls[0] as Call, "idempotency-key")).toBe(
      topUpCheckoutKey("intent-1"),
    );
    expect(headerOf(calls[1] as Call, "idempotency-key")).toBe(
      topUpCheckoutKey("intent-1"),
    );
    expect(headerOf(calls[2] as Call, "idempotency-key")).toBe(
      topUpCheckoutKey("intent-2"),
    );
    expect(topUpCheckoutKey("intent-1")).not.toBe(topUpCheckoutKey("intent-2"));
  });

  // #501-T02
  it("holds the 10 to 500 USD range itself and refuses before it calls Stripe, whatever Stripe would accept", async () => {
    const { adapter, calls } = stubbed();

    for (const amount of [
      9_990_000, // 9.99 USD: Stripe takes 50 cents
      9_999_999,
      500 * USD + 10_000, // 500.01 USD
      1 * USD,
      0,
      25 * USD + 5_000, // half a cent
    ])
      expect(
        await codeOf(
          adapter.createTopUpCheckout({ ...TOP_UP, amount: amount as never }),
        ),
        String(amount),
      ).toBe("amount_out_of_range");
    expect(calls).toHaveLength(0);

    for (const amount of [10 * USD, 500 * USD, 10 * USD + 10_000])
      await adapter.createTopUpCheckout({ ...TOP_UP, amount: toUsd(amount) });
    expect(
      calls.map((call) =>
        bodyOf(call).get("line_items[0][price_data][unit_amount]"),
      ),
    ).toEqual(["1000", "50000", "1001"]);
  });

  // #501-T03
  it("needs the customer: a top-up without one is refused before Stripe is called", async () => {
    const { adapter, calls } = stubbed();

    expect(
      await codeOf(adapter.createTopUpCheckout({ ...TOP_UP, customer: null })),
    ).toBe("customer_missing");
    expect(calls).toHaveLength(0);
  });

  // #501-T07
  it("turns what goes wrong at Stripe into a stable code of the adapter, without a word of Stripe's answer", async () => {
    const fail = (
      status: number,
      body: unknown = { error: { message: "secret detail" } },
    ) => stubbed(() => Response.json(body, { status }));
    const cases: Array<[string, number, string]> = [
      ["a 500", 500, "provider_unavailable"],
      ["a 429", 429, "provider_unavailable"],
      ["a 400", 400, "provider_rejected"],
      ["a 401", 401, "provider_not_configured"],
      ["a 403", 403, "provider_not_configured"],
      ["a 404", 404, "provider_rejected"],
      // Stripe: another request with the same Idempotency-Key is still running (#501-T14).
      ["a 409", 409, "request_in_progress"],
    ];
    for (const [label, status, code] of cases) {
      const { adapter } = fail(status);
      let seen: unknown;
      try {
        await adapter.createTopUpCheckout(TOP_UP);
      } catch (error) {
        seen = error;
      }
      expect(seen, label).toBeInstanceOf(BillingAdapterError);
      expect((seen as BillingAdapterError).code, label).toBe(code);
      expect(String(seen), label).not.toContain("secret detail");
    }
  });

  // #501-T07
  it("is provider_unavailable when Stripe cannot be reached, and provider_rejected for a session without a page", async () => {
    const down = stubbed(() => {
      throw new TypeError("connect ECONNREFUSED 10.0.0.1:443");
    });
    expect(await codeOf(down.adapter.createTopUpCheckout(TOP_UP))).toBe(
      "provider_unavailable",
    );

    const noPage = stubbed(() => Response.json({ ...SESSION, url: null }));
    expect(await codeOf(noPage.adapter.createTopUpCheckout(TOP_UP))).toBe(
      "provider_rejected",
    );
  });

  // #501-T07
  it("is provider_not_configured when no client can be made (no key, a key of the other environment)", async () => {
    for (const reason of [
      new Error("no key"),
      new StripeClientError("environment_mismatch"),
    ]) {
      const adapter: BillingAdapter = createStripeAdapter({
        client: () => Promise.reject(reason),
      });
      expect(await codeOf(adapter.createTopUpCheckout(TOP_UP))).toBe(
        "provider_not_configured",
      );
      expect(
        await codeOf(
          adapter.ensureCustomer({
            workspace: { id: "w1" },
            profile: {
              legalName: "Example GmbH",
              country: "DE",
              addressLines: ["Teststrasse 1"],
              postalCode: "10115",
              city: "Berlin",
              vatId: null,
              locale: "en",
            },
            customer: null,
          }),
        ),
      ).toBe("provider_not_configured");
    }
  });

  // Changed with #502: the adapter had no webhook until this issue wired it (the old test pinned "undefined"); it has one now,
  // and it can be asked about a top-up.
  it("has a webhook and a lookup of a top-up (#502)", () => {
    expect(stubbed().adapter.verifyAndParseWebhook).toBeTypeOf("function");
    expect(stubbed().adapter.lookupTopUp).toBeTypeOf("function");
  });
});
