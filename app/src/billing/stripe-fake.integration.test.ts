// SPDX-License-Identifier: Apache-2.0

// The Stripe client against the fake Stripe API (fakes/stripe) on a loopback port: the requests the client builds, the
// answers it parses, idempotency, the scripted bad days, and what the fake refuses like Managed Payments does.
import { describe, expect, it } from "vitest";
import { clientFor, startTestStripe } from "../test-support/stripe-fake.ts";
import {
  StripeClientError,
  type CreateCheckoutSessionInput,
  type StripeClient,
} from "./stripe-client.ts";

async function errorOf(promise: Promise<unknown>): Promise<StripeClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StripeClientError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
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
  client_reference_id: "intent-1",
  metadata: { intent: "intent-1" },
  managed_payments: { enabled: true },
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- answers of the fake, read field by field

/** A raw form POST, for the parameters the typed client refuses to send. */
async function rawPost(
  baseUrl: string,
  apiKey: string,
  path: string,
  entries: Array<[string, string]>,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(entries).toString(),
  });
  return {
    status: response.status,
    json: await response.json(),
    headers: response.headers,
  };
}

const MANAGED_SESSION_ENTRIES: Array<[string, string]> = [
  ["mode", "payment"],
  ["success_url", "https://app.example.test/ok"],
  ["cancel_url", "https://app.example.test/no"],
  ["line_items[0][quantity]", "1"],
  ["line_items[0][price_data][currency]", "usd"],
  ["line_items[0][price_data][unit_amount]", "1000"],
  ["line_items[0][price_data][product_data][name]", "Credit"],
  ["line_items[0][price_data][product_data][tax_code]", "txcd_10103001"],
  ["managed_payments[enabled]", "true"],
];

describe("the client against the fake", () => {
  // #500-T01
  it("creates a customer and a session, retrieves the session and creates a refund, with the bodies and answers Stripe has", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    const customer = await client.createCustomer({
      name: "Example GmbH",
      address: { line1: "Example 1", city: "Berlin", country: "DE" },
      preferred_locales: ["de"],
      tax_id_data: [{ type: "eu_vat", value: "DE123456789" }],
      metadata: { workspace: "w1" },
    });
    expect(customer).toMatchObject({
      name: "Example GmbH",
      metadata: { workspace: "w1" },
    });
    const withTaxIds = await client.getCustomer(customer.id, {
      expandTaxIds: true,
    });
    expect(withTaxIds.tax_ids?.data).toHaveLength(1);
    expect(withTaxIds.tax_ids?.data[0]).toMatchObject({
      type: "eu_vat",
      value: "DE123456789",
      verification: { status: "pending" },
    });
    // Without expand the tax ids are not in the answer, as at Stripe.
    expect((await client.getCustomer(customer.id)).tax_ids).toBeUndefined();

    const session = await client.createCheckoutSession(
      { ...SESSION_INPUT, customer: customer.id },
      { idempotencyKey: "topup-intent-1" },
    );
    expect(session).toMatchObject({
      status: "open",
      payment_status: "unpaid",
      mode: "payment",
      customer: customer.id,
      payment_intent: null,
      client_reference_id: "intent-1",
      metadata: { intent: "intent-1" },
      amount_total: 2500,
      currency: "usd",
    });
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/c\/pay\//);
    const again = await client.getCheckoutSession(session.id);
    expect(again.id).toBe(session.id);

    // The buyer pays, then the operator refunds half of it through the API.
    const paid = fake.buyer.pay(session.id);
    const refund = await client.createRefund(
      {
        payment_intent: paid.paymentIntent.id,
        amount: 1000,
        reason: "requested_by_customer",
      },
      { idempotencyKey: "refund-1" },
    );
    expect(refund).toMatchObject({
      amount: 1000,
      currency: "usd",
      status: "succeeded",
      charge: paid.charge.id,
      payment_intent: paid.paymentIntent.id,
      reason: "requested_by_customer",
    });
    expect(await client.getRefund(refund.id)).toMatchObject({ id: refund.id });
    expect(await client.getCharge(paid.charge.id)).toMatchObject({
      amount_refunded: 1000,
      refunded: false,
    });

    const requests = fake.requests();
    expect(requests.every((request) => request.authenticated)).toBe(true);
    expect(
      requests.every(
        (request) =>
          request.headers.stripeVersion ===
          "2025-03-31.basil; managed_payments_preview=v1",
      ),
    ).toBe(true);
    const creation = requests.find(
      (request) => request.path === "/v1/checkout/sessions",
    );
    expect(creation?.headers.idempotencyKey).toBe("topup-intent-1");
    expect(creation?.form).toMatchObject({
      mode: "payment",
      client_reference_id: "intent-1",
      managed_payments: { enabled: "true" },
      line_items: [{ price_data: { unit_amount: "2500" } }],
    });
  });

  // #500-T01
  it("takes the customer's profile changes, a tax id added and removed, and a deleted customer is not found", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    const customer = await client.createCustomer({
      name: "Old Name",
      metadata: { keep: "1", drop: "2" },
    });
    const updated = await client.updateCustomer(customer.id, {
      name: "New Name",
      metadata: { drop: null, add: "3" },
    });
    expect(updated).toMatchObject({
      name: "New Name",
      metadata: { keep: "1", add: "3" },
    });
    const taxId = await client.createCustomerTaxId(customer.id, {
      type: "eu_vat",
      value: "DE123456789",
    });
    expect(
      (await client.getCustomer(customer.id, { expandTaxIds: true })).tax_ids
        ?.data,
    ).toHaveLength(1);
    await client.deleteCustomerTaxId(customer.id, taxId.id);
    expect(
      (await client.getCustomer(customer.id, { expandTaxIds: true })).tax_ids
        ?.data,
    ).toHaveLength(0);
    fake.deleteCustomer(customer.id);
    const gone = await errorOf(client.getCustomer(customer.id));
    expect(gone.code).toBe("not_found");
    const unknown = await errorOf(client.getCustomer("cus_Nothing"));
    expect(unknown).toMatchObject({
      code: "not_found",
      status: 404,
      stripeCode: "resource_missing",
    });
  });

  // #500-T01
  it("reads the account and answers a wrong key with unauthorized, without echoing the key", async () => {
    const fake = await startTestStripe();
    expect(await clientFor(fake).getAccount()).toMatchObject({
      charges_enabled: true,
      country: "DE",
    });
    const wrong = clientFor(fake, {
      apiKey: "sk_test_not_the_key_of_the_fake",
    });
    const error = await errorOf(wrong.getAccount());
    expect(error.code).toBe("unauthorized");
    const raw = await fetch(`${fake.baseUrl}/v1/account`, {
      headers: { authorization: "Bearer sk_test_not_the_key_of_the_fake" },
    });
    expect(raw.status).toBe(401);
    expect(JSON.stringify(await raw.json())).not.toContain(
      "sk_test_not_the_key_of_the_fake",
    );
    const none = await fetch(`${fake.baseUrl}/v1/account`);
    expect(none.status).toBe(401);
  });

  // #500-T01
  it("keeps the secret of a webhook endpoint to the answer of the create, and lists newest first in pages", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    const first = await client.createWebhookEndpoint({
      url: "http://127.0.0.1:9/one",
      enabled_events: ["checkout.session.completed"],
      description: "one",
    });
    expect(first.secret).toMatch(/^whsec_/);
    expect(fake.secretOf(first.id)).toBe(first.secret);
    for (let n = 2; n <= 5; n += 1)
      await client.createWebhookEndpoint({
        url: `http://127.0.0.1:9/n${n}`,
        enabled_events: ["*"],
      });
    const listed = await client.listWebhookEndpoints();
    expect(listed).toHaveLength(5);
    expect(listed.every((endpoint) => endpoint.secret === undefined)).toBe(
      true,
    );
    expect(listed.at(-1)?.id).toBe(first.id);
    // Pages of two, as the client would meet them with a long list.
    const page = await fetch(`${fake.baseUrl}/v1/webhook_endpoints?limit=2`, {
      headers: { authorization: `Bearer ${fake.apiKey}` },
    });
    const body = (await page.json()) as { data: unknown[]; has_more: boolean };
    expect(body.data).toHaveLength(2);
    expect(body.has_more).toBe(true);
    await client.deleteWebhookEndpoint(first.id);
    expect(
      (await client.listWebhookEndpoints()).map((e) => e.id),
    ).not.toContain(first.id);
    expect((await errorOf(client.deleteWebhookEndpoint(first.id))).code).toBe(
      "not_found",
    );
  });
});

describe("idempotency", () => {
  // #500-T02
  it("answers the same POST with the same key again with the saved response, and creates nothing twice", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    const first = await client.createCustomer(
      { name: "Once" },
      { idempotencyKey: "key-1" },
    );
    const second = await client.createCustomer(
      { name: "Once" },
      { idempotencyKey: "key-1" },
    );
    expect(second).toEqual(first);
    expect(fake.customers()).toHaveLength(1);
    const raw = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      "/v1/customers",
      [["name", "Once"]],
      { "idempotency-key": "key-1" },
    );
    expect(raw.status).toBe(200);
    expect(raw.json.id).toBe(first.id);
    expect(raw.headers.get("idempotent-replayed")).toBe("true");
    // The first answer was not a replay.
    expect(fake.requests()[0]?.replayed).toBe(false);
    expect(fake.requests()[1]?.replayed).toBe(true);
  });

  // #500-T02
  it("refuses the same key with other parameters with the idempotency error, and changes nothing", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    await client.createCustomer({ name: "Once" }, { idempotencyKey: "key-1" });
    const error = await errorOf(
      client.createCustomer({ name: "Other" }, { idempotencyKey: "key-1" }),
    );
    expect(error).toMatchObject({
      code: "idempotency_conflict",
      status: 400,
      stripeType: "idempotency_error",
    });
    expect(fake.customers()).toHaveLength(1);
    const raw = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      "/v1/customers",
      [["name", "Other"]],
      { "idempotency-key": "key-1" },
    );
    expect(raw.json.error.type).toBe("idempotency_error");
    expect(raw.json.error.message).toContain("same parameters");
  });

  // #500-T02
  it("scopes a key to its path: the same key on another endpoint is another request", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    await client.createCustomer({ name: "A" }, { idempotencyKey: "shared" });
    const error = await errorOf(
      client.createWebhookEndpoint(
        { url: "http://127.0.0.1:9/x", enabled_events: ["*"] },
        { idempotencyKey: "shared" },
      ),
    );
    expect(error.code).toBe("idempotency_conflict");
  });

  // #500-T02
  it("does not count the order of the parameters or a GET as a different request", async () => {
    const fake = await startTestStripe();
    const first = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      "/v1/customers",
      [
        ["name", "A"],
        ["metadata[x]", "1"],
      ],
      { "idempotency-key": "order" },
    );
    const second = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      "/v1/customers",
      [
        ["metadata[x]", "1"],
        ["name", "A"],
      ],
      { "idempotency-key": "order" },
    );
    expect(second.json.id).toBe(first.json.id);
    expect(fake.customers()).toHaveLength(1);
  });
});

describe("scripted bad days", () => {
  // #500-T04
  it("answers a 429 with Retry-After and the client waits, then succeeds, within the bound", async () => {
    const fake = await startTestStripe();
    const sleeps: number[] = [];
    const client = clientFor(fake, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    fake.faults.rateLimit(
      { method: "GET", path: "/v1/account" },
      { retryAfterSeconds: 2, times: 2 },
    );
    await client.getAccount();
    expect(sleeps).toEqual([2000, 2000]);
    expect(fake.requests().map((request) => request.status)).toEqual([
      429, 429, 200,
    ]);

    fake.faults.rateLimit(
      { method: "GET", path: "/v1/account" },
      { retryAfterSeconds: 2, times: 5 },
    );
    const error = await errorOf(client.getAccount());
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(2);
    expect(fake.requests()).toHaveLength(6);
  });

  // #500-T04
  it("retries a 5xx on a GET", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    fake.faults.failWith({ method: "GET", path: "/v1/account" }, 503, {
      times: 1,
    });
    expect((await client.getAccount()).country).toBe("DE");
    expect(fake.requests().map((request) => request.status)).toEqual([
      503, 200,
    ]);
  });

  // #500-T04
  it("retries a 5xx on a POST with its idempotency key, and the thing is created once", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    fake.faults.failWith({ method: "POST", path: "/v1/customers" }, 500, {
      times: 2,
    });
    await client.createCustomer({ name: "Once" });
    const posts = fake
      .requests()
      .filter((request) => request.method === "POST");
    expect(posts).toHaveLength(3);
    const keys = new Set(
      posts.map((request) => request.headers.idempotencyKey),
    );
    expect(keys.size).toBe(1);
    expect(keys.has(null)).toBe(false);
    expect(fake.customers()).toHaveLength(1);
  });

  // #500-T04
  it("gives up on a POST that keeps failing, with server_error, after the bound", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    fake.faults.failWith({ method: "POST", path: "/v1/customers" }, 500, {
      times: 10,
    });
    const error = await errorOf(client.createCustomer({ name: "Never" }));
    expect(error.code).toBe("server_error");
    expect(fake.customers()).toHaveLength(0);
    expect(fake.requests()).toHaveLength(3);
  });

  // #500-T04
  it("survives a lost response: the POST ran, the answer never came, the repeat with the same key gets the saved answer", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake, { timeoutMs: 100 });
    fake.faults.dropResponse(
      { method: "POST", path: "/v1/customers" },
      { mode: "hang" },
    );
    const customer = await client.createCustomer({ name: "Once" });
    expect(fake.customers()).toHaveLength(1);
    expect(fake.customers()[0]?.id).toBe(customer.id);
    const posts = fake
      .requests()
      .filter((request) => request.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.replayed).toBe(true);
  });

  // #500-T04
  it("survives a connection that is reset after the POST ran", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake);
    fake.faults.dropResponse(
      { method: "POST", path: "/v1/customers" },
      { mode: "reset" },
    );
    const customer = await client.createCustomer({ name: "Once" });
    expect(fake.customers().map((c) => c.id)).toEqual([customer.id]);
  });

  // #500-T04
  it("times out on a slow answer and says so with timeout when it keeps being slow", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake, { timeoutMs: 50, maxRetries: 0 });
    fake.faults.delay({ path: "/v1/account" }, 500, { times: 1 });
    expect((await errorOf(client.getAccount())).code).toBe("timeout");
  });

  // #500-T06
  it("refuses an oversize answer and a redirect from a real socket", async () => {
    const fake = await startTestStripe();
    const client = clientFor(fake, { maxRetries: 0 });
    fake.faults.respondWith(
      { path: "/v1/account" },
      {
        status: 200,
        body: "x".repeat(2_100_000),
        contentType: "application/json",
      },
    );
    expect((await errorOf(client.getAccount())).code).toBe(
      "response_too_large",
    );
    fake.faults.respondWith(
      { path: "/v1/account" },
      { status: 302, headers: { location: "https://evil.example/" } },
    );
    expect((await errorOf(client.getAccount())).code).toBe("redirect_refused");
  });
});

describe("what Managed Payments does not support", () => {
  // #500-T09
  it.each([
    ["tax_id_collection[enabled]", "true"],
    ["invoice_creation[enabled]", "true"],
    ["customer_update[name]", "auto"],
    ["customer_update[address]", "auto"],
    ["payment_method_types[0]", "card"],
    ["custom_text[submit][message]", "Thanks"],
  ] as const)(
    "refuses %s on a managed one-time session as the documentation says, and creates nothing",
    async (name, value) => {
      const fake = await startTestStripe();
      const answer = await rawPost(
        fake.baseUrl,
        fake.apiKey,
        "/v1/checkout/sessions",
        [...MANAGED_SESSION_ENTRIES, [name, value]],
      );
      expect(answer.status).toBe(400);
      expect(answer.json.error.type).toBe("invalid_request_error");
      expect(answer.json.error.message).toMatch(/Managed Payments/);
      expect(fake.checkoutSessions()).toHaveLength(0);
    },
  );

  // #500-T09
  it("takes the same parameters on a session that is not managed", async () => {
    const fake = await startTestStripe();
    const entries = MANAGED_SESSION_ENTRIES.filter(
      ([name]) => !name.startsWith("managed_payments"),
    );
    const answer = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      "/v1/checkout/sessions",
      [...entries, ["tax_id_collection[enabled]", "true"]],
    );
    expect(answer.status).toBe(200);
    expect(answer.json.managed_payments).toEqual({ enabled: false });
  });

  // #500-T09
  it("needs an eligible product tax code on a managed session", async () => {
    const fake = await startTestStripe();
    const without = MANAGED_SESSION_ENTRIES.filter(
      ([name]) => !name.endsWith("[tax_code]"),
    );
    const missing = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      "/v1/checkout/sessions",
      without,
    );
    expect(missing.status).toBe(400);
    expect(missing.json.error.message).toContain("tax code is missing");
    const wrong = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      "/v1/checkout/sessions",
      [
        ...without,
        ["line_items[0][price_data][product_data][tax_code]", "not-a-code"],
      ],
    );
    expect(wrong.status).toBe(400);
    expect(fake.checkoutSessions()).toHaveLength(0);
  });

  // #501-X02: probed against the sandbox on 2026-10-21: the digital-goods family (`txcd_10...`) is eligible; `txcd_99999999`
  // (tangible goods), `txcd_00000000`, `txcd_20030000` and a text that is no code are refused with this message.
  it("refuses a tax code outside the family Managed Payments takes, with the message of the sandbox", async () => {
    const fake = await startTestStripe();
    const withCode = (code: string) => [
      ...MANAGED_SESSION_ENTRIES.filter(
        ([name]) => !name.endsWith("[tax_code]"),
      ),
      ["line_items[0][price_data][product_data][tax_code]", code] as [
        string,
        string,
      ],
    ];
    for (const code of ["txcd_99999999", "txcd_00000000", "txcd_20030000"]) {
      const refused = await rawPost(
        fake.baseUrl,
        fake.apiKey,
        "/v1/checkout/sessions",
        withCode(code),
      );
      expect(refused.status, code).toBe(400);
      expect(refused.json.error.message, code).toContain(
        "this product tax code is ineligible for Managed Payments",
      );
    }
    for (const code of ["txcd_10103001", "txcd_10105002"]) {
      const accepted = await rawPost(
        fake.baseUrl,
        fake.apiKey,
        "/v1/checkout/sessions",
        withCode(code),
      );
      expect(accepted.status, code).toBe(200);
    }
  });

  // #501-X03: probed against the sandbox on 2026-10-21 (API version 2025-03-31.basil): a customer takes `business_name`.
  it("takes business_name on a customer, when it is made and when it is changed", async () => {
    const fake = await startTestStripe();
    const created = await rawPost(fake.baseUrl, fake.apiKey, "/v1/customers", [
      ["name", "Example GmbH"],
      ["business_name", "Example GmbH"],
    ]);
    expect(created.status).toBe(200);
    expect(created.json.business_name).toBe("Example GmbH");
    const changed = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      `/v1/customers/${created.json.id}`,
      [["business_name", "Renamed GmbH"]],
    );
    expect(changed.status).toBe(200);
    expect(changed.json.business_name).toBe("Renamed GmbH");
  });

  // #500-T09
  it("refuses a parameter it does not know, a missing required one and a customer that does not exist, as Stripe does", async () => {
    const fake = await startTestStripe();
    const unknown = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      "/v1/checkout/sessions",
      [...MANAGED_SESSION_ENTRIES, ["nonsense", "1"]],
    );
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.message).toBe(
      "Received unknown parameter: nonsense",
    );
    const missing = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      "/v1/checkout/sessions",
      MANAGED_SESSION_ENTRIES.filter(([name]) => name !== "success_url"),
    );
    expect(missing.json.error).toMatchObject({
      type: "invalid_request_error",
      code: "parameter_missing",
      param: "success_url",
    });
    const customer = await rawPost(
      fake.baseUrl,
      fake.apiKey,
      "/v1/checkout/sessions",
      [...MANAGED_SESSION_ENTRIES, ["customer", "cus_Nothing"]],
    );
    expect(customer.status).toBe(400);
    expect(customer.json.error.code).toBe("resource_missing");
    expect(fake.checkoutSessions()).toHaveLength(0);
  });

  // #500-T09
  it("takes everything the client sends for a top-up", async () => {
    const fake = await startTestStripe();
    const client: StripeClient = clientFor(fake);
    const customer = await client.createCustomer({ name: "Example GmbH" });
    const session = await client.createCheckoutSession(
      { ...SESSION_INPUT, customer: customer.id },
      { idempotencyKey: "topup-intent-2" },
    );
    expect(session.status).toBe("open");
    const expired = await client.expireCheckoutSession(session.id);
    expect(expired).toMatchObject({ status: "expired", url: null });
    // An expired session cannot be expired or paid again.
    expect((await errorOf(client.expireCheckoutSession(session.id))).code).toBe(
      "bad_request",
    );
    expect(() => fake.buyer.pay(session.id)).toThrow(/not open/);
  });
});
