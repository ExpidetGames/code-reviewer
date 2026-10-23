// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  STRIPE_API_BASE_URL,
  STRIPE_API_VERSION,
  STRIPE_CLIENT_ERROR_CODES,
  STRIPE_MANAGED_PAYMENTS_API_VERSION,
  StripeClientError,
  createStripeClient,
  stripeKeyEnvironment,
  type CreateCheckoutSessionInput,
  type StripeClientOptions,
} from "./stripe-client.ts";

const API_KEY = "sk_test_dummyvalue_for_unit_tests_0001";
const CUSTOMER = {
  id: "cus_Fake0001",
  object: "customer",
  name: "Example GmbH",
  metadata: { workspace: "w1" },
  livemode: false,
};
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
  amount_total: 1000,
  amount_subtotal: 1000,
  currency: "usd",
  expires_at: 1_700_086_400,
  created: 1_700_000_000,
  livemode: false,
};
const REFUND = {
  id: "re_Fake0001",
  object: "refund",
  amount: 500,
  currency: "usd",
  charge: "ch_Fake0001",
  payment_intent: "pi_Fake0001",
  status: "succeeded",
  reason: null,
  created: 1_700_000_100,
  metadata: {},
};

type Call = { url: string; init: RequestInit };

/** A client whose fetch answers from `reply` (one reply or a function of the call), and what it received. */
function stubbed(
  reply: (call: Call, index: number) => Response | Promise<Response>,
  overrides: Partial<StripeClientOptions> = {},
) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let keys = 0;
  const client = createStripeClient({
    apiKey: API_KEY,
    baseUrl: "https://stripe.invalid",
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return reply(call, calls.length - 1);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    newIdempotencyKey: () => `generated-key-${(keys += 1)}`,
    ...overrides,
  });
  return { client, calls, sleeps };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const stripeError = (
  status: number,
  error: Record<string, unknown>,
  headers: Record<string, string> = {},
) => json({ error }, { status, headers });

async function errorOf(promise: Promise<unknown>): Promise<StripeClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StripeClientError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

const bodyOf = (call: Call | undefined) =>
  new URLSearchParams(String(call?.init.body));
const headersOf = (call: Call | undefined) =>
  new Headers(call?.init.headers as HeadersInit);

describe("the requests", () => {
  // #500-T01
  it("creates a customer: a form-encoded body with nested and listed fields, the key, the version and an idempotency key", async () => {
    const { client, calls } = stubbed(() => json(CUSTOMER));
    const customer = await client.createCustomer({
      name: "Example GmbH",
      address: { line1: "Example 1", city: "Berlin", country: "DE" },
      preferred_locales: ["de", "en"],
      tax_id_data: [{ type: "eu_vat", value: "DE123456789" }],
      metadata: { workspace: "w1" },
    });
    expect(customer).toMatchObject({
      id: "cus_Fake0001",
      name: "Example GmbH",
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://stripe.invalid/v1/customers");
    expect(call?.init.method).toBe("POST");
    const headers = headersOf(call);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("stripe-version")).toBe(
      "2025-03-31.basil; managed_payments_preview=v1",
    );
    expect(headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(headers.get("idempotency-key")).toBe("generated-key-1");
    expect(Object.fromEntries(bodyOf(call))).toEqual({
      name: "Example GmbH",
      "address[line1]": "Example 1",
      "address[city]": "Berlin",
      "address[country]": "DE",
      "preferred_locales[0]": "de",
      "preferred_locales[1]": "en",
      "tax_id_data[0][type]": "eu_vat",
      "tax_id_data[0][value]": "DE123456789",
      "metadata[workspace]": "w1",
    });
  });

  // #500-T01
  it("creates a Checkout session for Managed Payments: nested price_data, booleans and numbers as Stripe reads them", async () => {
    const { client, calls } = stubbed(() => json(SESSION));
    const session = await client.createCheckoutSession(
      {
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
        customer: "cus_Fake0001",
        client_reference_id: "intent-1",
        metadata: { intent: "intent-1" },
        managed_payments: { enabled: true },
      },
      { idempotencyKey: "topup-intent-1" },
    );
    expect(session).toMatchObject({
      id: "cs_test_Fake0001",
      status: "open",
      payment_status: "unpaid",
      payment_intent: null,
      url: "https://checkout.example.test/c/pay/cs_test_Fake0001",
    });
    const call = calls[0];
    expect(call?.url).toBe("https://stripe.invalid/v1/checkout/sessions");
    expect(headersOf(call).get("idempotency-key")).toBe("topup-intent-1");
    expect(Object.fromEntries(bodyOf(call))).toEqual({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "2500",
      "line_items[0][price_data][tax_behavior]": "exclusive",
      "line_items[0][price_data][product_data][name]": "Credit",
      "line_items[0][price_data][product_data][tax_code]": "txcd_10103001",
      success_url: "https://app.example.test/billing?paid=1",
      cancel_url: "https://app.example.test/billing",
      customer: "cus_Fake0001",
      client_reference_id: "intent-1",
      "metadata[intent]": "intent-1",
      "managed_payments[enabled]": "true",
    });
  });

  // #500-T01
  it("retrieves and expires a session, without a body, and sends no idempotency key on a GET", async () => {
    const { client, calls } = stubbed(() => json(SESSION));
    await client.getCheckoutSession("cs_test_Fake0001");
    await client.expireCheckoutSession("cs_test_Fake0001");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://stripe.invalid/v1/checkout/sessions/cs_test_Fake0001",
    );
    expect(calls[0]?.init.body).toBeUndefined();
    expect(headersOf(calls[0]).get("idempotency-key")).toBeNull();
    expect(calls[1]?.init.method).toBe("POST");
    expect(calls[1]?.url).toBe(
      "https://stripe.invalid/v1/checkout/sessions/cs_test_Fake0001/expire",
    );
    expect(headersOf(calls[1]).get("idempotency-key")).toBe("generated-key-1");
  });

  // #500-T01
  it("creates a refund of a payment intent or a charge, and retrieves one", async () => {
    const { client, calls } = stubbed(() => json(REFUND));
    const refund = await client.createRefund(
      {
        payment_intent: "pi_Fake0001",
        amount: 500,
        reason: "requested_by_customer",
        metadata: { note: "n" },
      },
      { idempotencyKey: "refund-1" },
    );
    expect(refund).toMatchObject({
      id: "re_Fake0001",
      amount: 500,
      status: "succeeded",
      charge: "ch_Fake0001",
      payment_intent: "pi_Fake0001",
    });
    expect(Object.fromEntries(bodyOf(calls[0]))).toEqual({
      payment_intent: "pi_Fake0001",
      amount: "500",
      reason: "requested_by_customer",
      "metadata[note]": "n",
    });
    await client.createRefund(
      { charge: "ch_Fake0001" },
      { idempotencyKey: "refund-2" },
    );
    expect(Object.fromEntries(bodyOf(calls[1]))).toEqual({
      charge: "ch_Fake0001",
    });
    await client.getRefund("re_Fake0001");
    expect(calls[2]?.url).toBe("https://stripe.invalid/v1/refunds/re_Fake0001");
  });

  // #500-T17
  it("cannot be called to move money without an idempotency key: the type refuses it", () => {
    // A compile-time check, run by `tsc` in `make verify`: each `@ts-expect-error` fails the typecheck as soon as the key
    // is optional again. The function is never called.
    const neverCalled = (client: ReturnType<typeof createStripeClient>) => {
      // @ts-expect-error a refund needs an idempotency key
      void client.createRefund({ charge: "ch_a" });
      // @ts-expect-error an empty option object has no idempotency key either
      void client.createRefund({ charge: "ch_a" }, {});
      // @ts-expect-error a Checkout session needs an idempotency key
      void client.createCheckoutSession({} as CreateCheckoutSessionInput);
      // With the key it compiles.
      void client.createRefund({ charge: "ch_a" }, { idempotencyKey: "k" });
    };
    expect(neverCalled).toBeTypeOf("function");
  });

  // #500-T01
  it("refuses a refund of neither or of both a payment intent and a charge, before any request", async () => {
    const { client, calls } = stubbed(() => json(REFUND));
    expect(
      (await errorOf(client.createRefund({}, { idempotencyKey: "refund-3" })))
        .code,
    ).toBe("invalid_argument");
    expect(
      (
        await errorOf(
          client.createRefund(
            { payment_intent: "pi_a", charge: "ch_a" },
            { idempotencyKey: "refund-4" },
          ),
        )
      ).code,
    ).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  // #500-T01
  it("reads a customer with its tax ids when asked to, and updates one", async () => {
    const withTaxIds = {
      ...CUSTOMER,
      tax_ids: {
        object: "list",
        has_more: false,
        data: [
          {
            id: "txi_Fake0001",
            object: "tax_id",
            type: "eu_vat",
            value: "DE123456789",
            verification: { status: "pending" },
          },
        ],
      },
    };
    const { client, calls } = stubbed(() => json(withTaxIds));
    const customer = await client.getCustomer("cus_Fake0001", {
      expandTaxIds: true,
    });
    expect(calls[0]?.url).toBe(
      "https://stripe.invalid/v1/customers/cus_Fake0001?expand%5B%5D=tax_ids",
    );
    expect(customer.tax_ids?.data[0]).toMatchObject({
      id: "txi_Fake0001",
      type: "eu_vat",
      verification: { status: "pending" },
    });
    await client.updateCustomer("cus_Fake0001", {
      name: "New Name GmbH",
      metadata: { stale: null },
    });
    expect(calls[1]?.url).toBe(
      "https://stripe.invalid/v1/customers/cus_Fake0001",
    );
    expect(calls[1]?.init.method).toBe("POST");
    expect(Object.fromEntries(bodyOf(calls[1]))).toEqual({
      name: "New Name GmbH",
      "metadata[stale]": "",
    });
  });

  // #500-T01
  it("adds and removes a tax id of a customer", async () => {
    const taxId = {
      id: "txi_Fake0002",
      object: "tax_id",
      type: "eu_vat",
      value: "DE123456789",
      verification: { status: "pending" },
    };
    const { client, calls } = stubbed((call) =>
      call.init.method === "DELETE"
        ? json({ id: "txi_Fake0002", object: "tax_id", deleted: true })
        : json(taxId),
    );
    const created = await client.createCustomerTaxId("cus_Fake0001", {
      type: "eu_vat",
      value: "DE123456789",
    });
    expect(created.id).toBe("txi_Fake0002");
    expect(calls[0]?.url).toBe(
      "https://stripe.invalid/v1/customers/cus_Fake0001/tax_ids",
    );
    expect(Object.fromEntries(bodyOf(calls[0]))).toEqual({
      type: "eu_vat",
      value: "DE123456789",
    });
    await client.deleteCustomerTaxId("cus_Fake0001", "txi_Fake0002");
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(calls[1]?.url).toBe(
      "https://stripe.invalid/v1/customers/cus_Fake0001/tax_ids/txi_Fake0002",
    );
  });

  // #500-T01
  it("treats a customer that Stripe reports as deleted as not found", async () => {
    const { client } = stubbed(() =>
      json({ id: "cus_Fake0001", object: "customer", deleted: true }),
    );
    const error = await errorOf(client.getCustomer("cus_Fake0001"));
    expect(error.code).toBe("not_found");
  });

  // #500-T01
  it("retrieves a payment intent and a charge", async () => {
    const { client, calls } = stubbed((call) =>
      call.url.includes("/charges/")
        ? json({
            id: "ch_Fake0001",
            object: "charge",
            amount: 1000,
            amount_refunded: 0,
            currency: "usd",
            payment_intent: "pi_Fake0001",
            status: "succeeded",
            refunded: false,
            disputed: false,
            paid: true,
            created: 1_700_000_050,
            metadata: {},
          })
        : json({
            id: "pi_Fake0001",
            object: "payment_intent",
            status: "succeeded",
            amount: 1000,
            amount_received: 1000,
            currency: "usd",
            latest_charge: "ch_Fake0001",
            customer: "cus_Fake0001",
            metadata: {},
            created: 1_700_000_040,
            livemode: false,
          }),
    );
    const intent = await client.getPaymentIntent("pi_Fake0001");
    const charge = await client.getCharge("ch_Fake0001");
    expect(intent).toMatchObject({
      latest_charge: "ch_Fake0001",
      amount: 1000,
    });
    expect(charge).toMatchObject({
      payment_intent: "pi_Fake0001",
      amount_refunded: 0,
      disputed: false,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://stripe.invalid/v1/payment_intents/pi_Fake0001",
      "https://stripe.invalid/v1/charges/ch_Fake0001",
    ]);
  });

  // #500-T01
  it("creates, lists and deletes webhook endpoints; the secret is only in the answer to the create", async () => {
    const endpoint = {
      id: "we_Fake0001",
      object: "webhook_endpoint",
      url: "https://app.example.test/api/billing/webhook",
      status: "enabled",
      enabled_events: ["checkout.session.completed"],
      description: "code-review.com",
      api_version: null,
      livemode: false,
    };
    const { client, calls } = stubbed((call) => {
      if (call.init.method === "DELETE")
        return json({
          id: "we_Fake0001",
          object: "webhook_endpoint",
          deleted: true,
        });
      if (call.init.method === "POST")
        return json({ ...endpoint, secret: "whsec_dummy_for_unit_tests" });
      return json({ object: "list", data: [endpoint], has_more: false });
    });
    const created = await client.createWebhookEndpoint({
      url: endpoint.url,
      enabled_events: ["checkout.session.completed", "charge.refunded"],
      description: "code-review.com",
    });
    expect(created.secret).toBe("whsec_dummy_for_unit_tests");
    expect(Object.fromEntries(bodyOf(calls[0]))).toEqual({
      url: endpoint.url,
      "enabled_events[0]": "checkout.session.completed",
      "enabled_events[1]": "charge.refunded",
      description: "code-review.com",
    });
    const listed = await client.listWebhookEndpoints();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.secret).toBeUndefined();
    expect(calls[1]?.url).toBe(
      "https://stripe.invalid/v1/webhook_endpoints?limit=100",
    );
    await client.deleteWebhookEndpoint("we_Fake0001");
    expect(calls[2]?.init.method).toBe("DELETE");
    expect(calls[2]?.url).toBe(
      "https://stripe.invalid/v1/webhook_endpoints/we_Fake0001",
    );
  });

  // #500-T01
  it("follows the pages of the endpoint list and refuses a list it cannot read to the end", async () => {
    const endpoint = (n: number) => ({
      id: `we_Fake${n}`,
      object: "webhook_endpoint",
      url: "https://app.example.test/x",
      status: "enabled",
      enabled_events: ["*"],
      description: null,
      api_version: null,
      livemode: false,
    });
    const pages = stubbed((call) =>
      call.url.includes("starting_after=we_Fake1")
        ? json({ object: "list", data: [endpoint(2)], has_more: false })
        : json({ object: "list", data: [endpoint(1)], has_more: true }),
    );
    const all = await pages.client.listWebhookEndpoints();
    expect(all.map((item) => item.id)).toEqual(["we_Fake1", "we_Fake2"]);
    expect(pages.calls[1]?.url).toContain("starting_after=we_Fake1");

    const endless = stubbed((_call, index) =>
      json({ object: "list", data: [endpoint(index + 1)], has_more: true }),
    );
    expect((await errorOf(endless.client.listWebhookEndpoints())).code).toBe(
      "invalid_response",
    );
    expect(endless.calls.length).toBeLessThanOrEqual(21);
  });

  // #500-T01
  it("reads the account, the connection check", async () => {
    const { client, calls } = stubbed(() =>
      json({
        id: "acct_Fake0001",
        object: "account",
        charges_enabled: true,
        details_submitted: true,
        country: "DE",
        default_currency: "eur",
        email: "owner@example.test",
      }),
    );
    const account = await client.getAccount();
    expect(account).toEqual({
      id: "acct_Fake0001",
      charges_enabled: true,
      details_submitted: true,
      country: "DE",
      default_currency: "eur",
    });
    expect(calls[0]?.url).toBe("https://stripe.invalid/v1/account");
  });

  // #500-T01
  it("pins the API version, with Managed Payments by default and without it when asked", async () => {
    expect(STRIPE_API_VERSION).toBe("2025-03-31.basil");
    expect(STRIPE_MANAGED_PAYMENTS_API_VERSION).toBe(
      "2025-03-31.basil; managed_payments_preview=v1",
    );
    const plain = stubbed(() => json(CUSTOMER), { managedPayments: false });
    await plain.client.getCustomer("cus_Fake0001");
    expect(headersOf(plain.calls[0]).get("stripe-version")).toBe(
      "2025-03-31.basil",
    );
  });

  // #500-T01
  it("refuses an id that is not an id and a key or value that could break out of the form, before any request", async () => {
    const { client, calls } = stubbed(() => json(CUSTOMER));
    for (const bad of [
      "",
      "cus_a/b",
      "cus_a?x=1",
      "../x",
      "cus a",
      "a".repeat(300),
    ])
      expect((await errorOf(client.getCustomer(bad))).code).toBe(
        "invalid_argument",
      );
    expect(
      (await errorOf(client.createCustomer({ metadata: { "a]=b&c[": "x" } })))
        .code,
    ).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  // #500-T01
  it("encodes values with reserved characters so that they stay one value", async () => {
    const { client, calls } = stubbed(() => json(CUSTOMER));
    await client.createCustomer({ name: "A&B=C [x] ü" });
    expect(bodyOf(calls[0]).get("name")).toBe("A&B=C [x] ü");
    expect(Array.from(bodyOf(calls[0]).keys())).toEqual(["name"]);
  });
});

describe("idempotency keys", () => {
  // #500-T04
  it("sends the same key on every try of one call, and another key for the next call", async () => {
    const { client, calls } = stubbed((_call, index) =>
      index < 2 ? stripeError(500, { type: "api_error" }) : json(CUSTOMER),
    );
    await client.createCustomer({ name: "A" });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => headersOf(call).get("idempotency-key"))).toEqual(
      ["generated-key-1", "generated-key-1", "generated-key-1"],
    );
    await client.createCustomer({ name: "B" });
    expect(headersOf(calls[3]).get("idempotency-key")).toBe("generated-key-2");
  });

  // #500-T04
  it("refuses a key that is empty, too long or not printable ASCII, before any request", async () => {
    const { client, calls } = stubbed(() => json(CUSTOMER));
    for (const key of ["", "a".repeat(256), "line\nbreak", "ü", " lead"])
      expect(
        (
          await errorOf(
            client.createCustomer({ name: "A" }, { idempotencyKey: key }),
          )
        ).code,
      ).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });
});

describe("the key and the address", () => {
  // #500-T03
  it("reads the environment of a key from its prefix alone", () => {
    expect(stripeKeyEnvironment("sk_test_abc")).toBe("test");
    expect(stripeKeyEnvironment("rk_test_abc")).toBe("test");
    expect(stripeKeyEnvironment("sk_live_abc")).toBe("live");
    expect(stripeKeyEnvironment("rk_live_abc")).toBe("live");
    for (const other of ["", "pk_test_abc", "sk_abc", "whsec_abc", "SK_TEST_a"])
      expect(stripeKeyEnvironment(other)).toBeNull();
  });

  // #500-T03
  it.each([
    ["sk_test_abc", "live"],
    ["rk_test_abc", "live"],
    ["sk_live_abc", "test"],
    ["rk_live_abc", "test"],
    ["pk_test_abc", "test"],
    ["unknown_prefix_abc", "test"],
    ["unknown_prefix_abc", "live"],
  ] as const)(
    "refuses the key %s on Stripe's address configured for %s with environment_mismatch",
    (apiKey, environment) => {
      let thrown: unknown;
      try {
        createStripeClient({
          apiKey,
          baseUrl: STRIPE_API_BASE_URL,
          environment,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(StripeClientError);
      expect((thrown as StripeClientError).code).toBe("environment_mismatch");
      expect((thrown as StripeClientError).message).not.toContain(apiKey);
    },
  );

  // #500-T03
  it("accepts a key of the configured environment on Stripe's address", () => {
    for (const [apiKey, environment] of [
      ["sk_test_abc", "test"],
      ["rk_test_abc", "test"],
      ["sk_live_abc", "live"],
      ["rk_live_abc", "live"],
    ] as const)
      expect(() =>
        createStripeClient({
          apiKey,
          baseUrl: STRIPE_API_BASE_URL,
          environment,
        }),
      ).not.toThrow();
  });

  // #500-T03
  it("needs the environment on Stripe's address, and takes no mismatching address in a different spelling", () => {
    expect(() =>
      createStripeClient({
        apiKey: "sk_test_abc",
        baseUrl: STRIPE_API_BASE_URL,
      }),
    ).toThrow(/not configured/);
    for (const spelling of [
      "https://api.stripe.com/",
      "https://API.stripe.com",
      "https://api.stripe.com:443/v1",
      "https://api.stripe.com.",
      "https://api.stripe.com..",
      "https://api.stripe.com%2e",
      "https://API.STRIPE.COM.:443/",
      "http://api.stripe.com",
      "http://api.stripe.com:80",
      "https://files.stripe.com",
      "https://stripe.com",
    ])
      expect(
        () =>
          createStripeClient({
            apiKey: "sk_live_abc",
            baseUrl: spelling,
            environment: "test",
          }),
        spelling,
      ).toThrow(StripeClientError);
  });

  // #500-T03
  it("treats every spelling of Stripe's host as Stripe's: the environment is needed and the key must fit it", () => {
    for (const spelling of [
      "https://api.stripe.com.",
      "https://api.stripe.com%2e",
      "https://API.Stripe.Com.:443/v1",
    ]) {
      const code = (options: Partial<StripeClientOptions>) => {
        try {
          createStripeClient({
            apiKey: "sk_live_abc",
            baseUrl: spelling,
            ...options,
          });
        } catch (error) {
          return (error as StripeClientError).code;
        }
        return null;
      };
      expect(code({})).toBe("invalid_configuration");
      expect(code({ environment: "test" })).toBe("environment_mismatch");
      expect(code({ environment: "live" })).toBeNull();
    }
  });

  // #500-T16
  it("never sends a key over plain http, except to the loopback of this machine", () => {
    for (const baseUrl of [
      "http://api.stripe.com",
      "http://stripe.invalid",
      "http://stripe-fake:4010",
      "http://10.0.0.5:4010",
      "http://localhost.example.test",
      "http://127.0.0.1.example.test",
    ])
      expect(
        () => createStripeClient({ apiKey: "sk_test_abc", baseUrl }),
        baseUrl,
      ).toThrow(/not configured/);
    for (const baseUrl of [
      "http://127.0.0.1:4010",
      "http://127.5.6.7:1",
      "http://localhost:4010",
      "http://LOCALHOST.:4010",
      "http://[::1]:4010",
      "https://stripe.invalid",
    ])
      expect(
        () => createStripeClient({ apiKey: "sk_test_abc", baseUrl }),
        baseUrl,
      ).not.toThrow();
  });

  // #500-T03
  it("accepts any key on any other address, such as the fake", () => {
    for (const apiKey of ["sk_test_abc", "sk_live_abc", "anything", "x"])
      expect(() =>
        createStripeClient({ apiKey, baseUrl: "http://127.0.0.1:4010" }),
      ).not.toThrow();
  });

  // #500-T03
  it("refuses an empty key and an address that is not http(s)", () => {
    for (const options of [
      { apiKey: "", baseUrl: "http://127.0.0.1:1" },
      { apiKey: "sk_test_a", baseUrl: "not a url" },
      { apiKey: "sk_test_a", baseUrl: "file:///etc/passwd" },
      { apiKey: "sk_test_a", baseUrl: "ftp://example.test" },
    ])
      expect(() => createStripeClient(options)).toThrow(/not configured/);
  });
});

describe("rate limits, server errors and retries", () => {
  // #500-T04
  it("waits for Retry-After on a 429 and tries again", async () => {
    const { client, calls, sleeps } = stubbed((_call, index) =>
      index === 0
        ? stripeError(429, { type: "rate_limit_error" }, { "retry-after": "3" })
        : json(CUSTOMER),
    );
    await client.getCustomer("cus_Fake0001");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  // #500-T04
  it("gives up on a 429 after the bound, and at once when the wait is longer than the cap", async () => {
    const always = stubbed(() =>
      stripeError(429, { type: "rate_limit_error" }, { "retry-after": "1" }),
    );
    const error = await errorOf(always.client.getCustomer("cus_Fake0001"));
    expect(error.code).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(1);
    expect(always.calls).toHaveLength(3);

    const long = stubbed(() =>
      stripeError(429, { type: "rate_limit_error" }, { "retry-after": "600" }),
    );
    expect((await errorOf(long.client.getCustomer("cus_Fake0001"))).code).toBe(
      "rate_limited",
    );
    expect(long.calls).toHaveLength(1);
    expect(long.sleeps).toEqual([]);
  });

  // #500-T04
  it("retries a 429 of a POST with the same key", async () => {
    const { client, calls } = stubbed((_call, index) =>
      index === 0
        ? stripeError(429, { type: "rate_limit_error" })
        : json(CUSTOMER),
    );
    await client.createCustomer({ name: "A" });
    expect(calls).toHaveLength(2);
    expect(headersOf(calls[0]).get("idempotency-key")).toBe(
      headersOf(calls[1]).get("idempotency-key"),
    );
  });

  // #500-T04
  it("retries a 5xx on a GET, and a 5xx on a POST only because it carries its idempotency key", async () => {
    const get = stubbed((_call, index) =>
      index === 0 ? stripeError(503, { type: "api_error" }) : json(CUSTOMER),
    );
    await get.client.getCustomer("cus_Fake0001");
    expect(get.calls).toHaveLength(2);
    expect(get.sleeps.length).toBe(1);

    const post = stubbed((_call, index) =>
      index === 0 ? stripeError(500, { type: "api_error" }) : json(CUSTOMER),
    );
    await post.client.createCustomer({ name: "A" });
    expect(post.calls).toHaveLength(2);
    for (const call of post.calls)
      expect(headersOf(call).get("idempotency-key")).toBe("generated-key-1");
  });

  // #500-T04
  it("backs off longer with each try of a 5xx and stops at the bound with server_error", async () => {
    const { client, calls, sleeps } = stubbed(() =>
      stripeError(500, { type: "api_error" }),
    );
    const error = await errorOf(client.getCustomer("cus_Fake0001"));
    expect(error.code).toBe("server_error");
    expect(error.status).toBe(500);
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
  });

  // #500-T04
  it("does not retry when Stripe says not to, or an answer that is a refusal", async () => {
    const noRetry = stubbed(() =>
      stripeError(
        500,
        { type: "api_error" },
        { "stripe-should-retry": "false" },
      ),
    );
    expect((await errorOf(noRetry.client.getCustomer("cus_a"))).code).toBe(
      "server_error",
    );
    expect(noRetry.calls).toHaveLength(1);
    for (const status of [400, 401, 403, 404, 409])
      expect(
        (
          await errorOf(
            stubbed(() =>
              stripeError(status, { type: "invalid_request_error" }),
            ).client.getCustomer("cus_a"),
          )
        ).status,
      ).toBe(status);
    const refusals = stubbed(() =>
      stripeError(400, { type: "invalid_request_error" }),
    );
    await errorOf(refusals.client.createCustomer({ name: "A" }));
    expect(refusals.calls).toHaveLength(1);
  });

  // #500-T04
  it("retries a lost connection and a timeout of a GET and of a POST with its key", async () => {
    const lost = stubbed((_call, index) => {
      if (index === 0) throw new TypeError("fetch failed");
      return json(CUSTOMER);
    });
    await lost.client.getCustomer("cus_Fake0001");
    expect(lost.calls).toHaveLength(2);
    const post = stubbed((_call, index) => {
      if (index === 0) throw new TypeError("fetch failed");
      return json(CUSTOMER);
    });
    await post.client.createCustomer({ name: "A" });
    expect(post.calls).toHaveLength(2);
    expect(headersOf(post.calls[1]).get("idempotency-key")).toBe(
      "generated-key-1",
    );
  });

  // #500-T04
  it("maps the statuses to stable codes", async () => {
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [
        400,
        { type: "invalid_request_error", code: "parameter_missing" },
        "bad_request",
      ],
      [400, { type: "idempotency_error" }, "idempotency_conflict"],
      [401, { type: "invalid_request_error" }, "unauthorized"],
      [402, { type: "card_error", code: "card_declined" }, "rejected"],
      [403, { type: "invalid_request_error" }, "forbidden"],
      [
        404,
        { type: "invalid_request_error", code: "resource_missing" },
        "not_found",
      ],
      [409, { type: "invalid_request_error" }, "conflict"],
      [418, { type: "invalid_request_error" }, "rejected"],
    ];
    for (const [status, body, code] of cases) {
      const error = await errorOf(
        stubbed(() => stripeError(status, body)).client.getCustomer("cus_a"),
      );
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    }
  });

  // #500-T04
  it("carries Stripe's own error code when it is a plain identifier, so a 404 can be told from other 404s", async () => {
    const error = await errorOf(
      stubbed(() =>
        stripeError(404, {
          type: "invalid_request_error",
          code: "resource_missing",
        }),
      ).client.getCustomer("cus_a"),
    );
    expect(error.stripeCode).toBe("resource_missing");
    expect(error.stripeType).toBe("invalid_request_error");
    const odd = await errorOf(
      stubbed(() =>
        stripeError(400, {
          type: "x y",
          code: "has space and secret sk_test_zzz",
        }),
      ).client.getCustomer("cus_a"),
    );
    expect(odd.stripeCode).toBeNull();
    expect(odd.stripeType).toBeNull();
  });
});

describe("what never gets out", () => {
  const SENTINEL_BODY = "SENTINEL-BODY-TEXT-DO-NOT-LEAK";
  const SENTINEL_HEADER = "SENTINEL-HEADER-DO-NOT-LEAK";

  async function everyFailure() {
    const failures: StripeClientError[] = [];
    const answers: Array<() => Response | Promise<Response>> = [
      () =>
        stripeError(
          400,
          {
            type: "invalid_request_error",
            code: "parameter_invalid",
            message: `${SENTINEL_BODY} ${API_KEY}`,
          },
          { "x-sentinel": SENTINEL_HEADER },
        ),
      () =>
        stripeError(401, {
          type: "invalid_request_error",
          message: SENTINEL_BODY,
        }),
      () =>
        stripeError(404, {
          type: "invalid_request_error",
          message: SENTINEL_BODY,
        }),
      () => stripeError(500, { type: "api_error", message: SENTINEL_BODY }),
      () =>
        stripeError(
          429,
          { type: "rate_limit_error", message: SENTINEL_BODY },
          { "retry-after": "1", "x-sentinel": SENTINEL_HEADER },
        ),
      () => new Response(`not json ${SENTINEL_BODY}`, { status: 200 }),
      () => json({ id: SENTINEL_BODY, object: "not_a_customer" }),
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://evil.example/${SENTINEL_HEADER}` },
        }),
      () => {
        throw new TypeError(`connect failed for ${API_KEY} ${SENTINEL_BODY}`);
      },
    ];
    for (const answer of answers) {
      const { client } = stubbed(answer);
      failures.push(await errorOf(client.getCustomer("cus_Fake0001")));
      failures.push(await errorOf(client.createCustomer({ name: "A" })));
    }
    return failures;
  }

  // #500-T05
  it("carries no key, no response body and no header in any error", async () => {
    const failures = await everyFailure();
    expect(failures.length).toBeGreaterThan(10);
    for (const error of failures) {
      const dump = [
        error.message,
        error.stack ?? "",
        String(error),
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
        JSON.stringify(Object.entries(error)),
      ].join("\n");
      expect(dump).not.toContain(API_KEY);
      expect(dump).not.toContain("sk_test_");
      expect(dump).not.toContain(SENTINEL_BODY);
      expect(dump).not.toContain(SENTINEL_HEADER);
      expect(dump).not.toContain("evil.example");
      expect(error.cause).toBeUndefined();
      expect(STRIPE_CLIENT_ERROR_CODES).toContain(error.code);
    }
  });

  // #500-T05
  it("logs nothing, not on success and not on failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    await everyFailure();
    const { client } = stubbed(() => json(CUSTOMER));
    await client.getCustomer("cus_Fake0001");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  // #500-T05
  it("has a fixed text for every code", () => {
    const seen = new Set<string>();
    for (const code of STRIPE_CLIENT_ERROR_CODES) {
      const message = new StripeClientError(code).message;
      expect(message.length).toBeGreaterThan(10);
      seen.add(message);
    }
    expect(seen.size).toBe(STRIPE_CLIENT_ERROR_CODES.length);
  });

  // #500-T05
  it("sends the key only in the Authorization header", async () => {
    const { client, calls } = stubbed(() => json(CUSTOMER));
    await client.createCustomer({ name: "A" });
    await client.getCustomer("cus_Fake0001");
    for (const call of calls) {
      expect(call.url).not.toContain(API_KEY);
      expect(String(call.init.body ?? "")).not.toContain(API_KEY);
      const others = Array.from(headersOf(call)).filter(
        ([name]) => name !== "authorization",
      );
      expect(JSON.stringify(others)).not.toContain(API_KEY);
    }
  });
});

describe("the limits", () => {
  // #500-T06
  it("refuses an answer that grows past the limit, whether it says so or not, and stops reading", async () => {
    const chunk = new Uint8Array(512 * 1024).fill(0x20);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
        if (pulled > 100) controller.close();
      },
    });
    const undeclared = stubbed(
      () =>
        new Response(endless, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect((await errorOf(undeclared.client.getCustomer("cus_a"))).code).toBe(
      "response_too_large",
    );
    expect(pulled).toBeLessThan(10);

    const declared = stubbed(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": "99999999" },
        }),
    );
    expect((await errorOf(declared.client.getCustomer("cus_a"))).code).toBe(
      "response_too_large",
    );
  });

  // #500-T06
  it("refuses an oversize error body the same way", async () => {
    const big = "x".repeat(2_100_000);
    const { client } = stubbed(() => new Response(big, { status: 500 }));
    expect((await errorOf(client.getCustomer("cus_a"))).code).toBe(
      "response_too_large",
    );
  });

  // #500-T06
  it("follows no redirect and does not try again", async () => {
    const { client, calls } = stubbed(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://evil.example/" },
        }),
    );
    const error = await errorOf(client.getCustomer("cus_a"));
    expect(error.code).toBe("redirect_refused");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  // #500-T06
  it("gives up on a request that does not end, after the time limit", async () => {
    const { client, calls } = stubbed(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      { timeoutMs: 20, maxRetries: 0 },
    );
    const error = await errorOf(client.getCustomer("cus_a"));
    expect(error.code).toBe("timeout");
    expect(calls).toHaveLength(1);
  });

  // #500-T06
  it("also gives up on a body that stalls after the headers", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const { client } = stubbed(() => new Response(stalled, { status: 200 }), {
      timeoutMs: 20,
      maxRetries: 0,
    });
    expect((await errorOf(client.getCustomer("cus_a"))).code).toBe("timeout");
  });

  // #500-T06
  it("uses a ten second limit by default", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const { client } = stubbed(() => json(CUSTOMER));
    await client.getCustomer("cus_a");
    expect(spy).toHaveBeenCalledWith(10_000);
  });

  // #500-T06
  it("refuses an answer that is not JSON or not the shape the app reads, with invalid_response", async () => {
    for (const answer of [
      () => new Response("<html>", { status: 200 }),
      () => json({ object: "customer" }),
      () => json({ id: "cus_a", object: "charge" }),
      () => json(["cus_a"]),
      () => new Response(null, { status: 200 }),
    ])
      expect(
        (await errorOf(stubbed(answer).client.getCustomer("cus_a"))).code,
      ).toBe("invalid_response");
  });

  // #500-T06
  it("keeps to the fields it reads: an unknown field is ignored, a wrong type is refused", async () => {
    const extra = stubbed(() => json({ ...CUSTOMER, future_field: { a: 1 } }));
    expect((await extra.client.getCustomer("cus_a")).id).toBe("cus_Fake0001");
    const wrong = stubbed(() => json({ ...SESSION, status: 7 }));
    expect(
      (await errorOf(wrong.client.getCheckoutSession("cs_test_a"))).code,
    ).toBe("invalid_response");
  });
});

describe("the address", () => {
  // #500-T12
  it("sends every request to the injected base URL and nowhere else", async () => {
    const { client, calls } = stubbed(() => json(CUSTOMER), {
      baseUrl: "http://127.0.0.1:4999/prefix-is-dropped",
    });
    await client.getCustomer("cus_a");
    await client.createCustomer({ name: "A" });
    for (const call of calls)
      expect(new URL(call.url).origin).toBe("http://127.0.0.1:4999");
  });

  // #500-T12
  it("names no host of its own in the source except Stripe's one address", () => {
    const source = readFileSync(
      new URL("./stripe-client.ts", import.meta.url),
      "utf8",
    );
    const hosts = [...source.matchAll(/https?:\/\/[^\s"'`)]+/g)].map(
      (match) => match[0],
    );
    expect(
      new Set(hosts.filter((host) => !host.includes("docs.stripe.com"))),
    ).toEqual(new Set([STRIPE_API_BASE_URL]));
  });

  // #500-T12
  it("is stopped by the network guard when it reaches for a host that is not loopback", async () => {
    const client = createStripeClient({
      apiKey: "sk_test_dummy",
      baseUrl: STRIPE_API_BASE_URL,
      environment: "test",
      maxRetries: 0,
      sleep: () => Promise.resolve(),
    });
    const error = await errorOf(client.getAccount());
    expect(error.code).toBe("network_error");
    expect(error.status).toBeNull();
  });
});
