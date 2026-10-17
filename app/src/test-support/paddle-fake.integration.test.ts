// SPDX-License-Identifier: Apache-2.0

// Pins down the fake Paddle (fakes/paddle) over real HTTP the way the client of the app speaks to it: the
// documented request shapes are enforced, errors are Paddle shaped (their codes are classified as documented
// or unverified), the app's own price rule is the client's and not the fake's, and the lifecycle calls behave
// like Paddle where the research says how Paddle behaves (fakes/README.md). A wrong fake fails here before it misleads a route test.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCUMENTED_ERROR_CODES,
  UNVERIFIED_ERROR_CODES,
} from "../../../fakes/paddle/errors.ts";
import { loadPaddleFixture } from "../../../fakes/paddle/fixtures.ts";
import { clientFor, startTestPaddle } from "./paddle-fake.ts";

const FAKE_DIR = join(import.meta.dirname, "../../../fakes/paddle");

type Answer = { status: number; json: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any -- a test reads whatever shape the fake answered

async function call(
  fake: { baseUrl: string; apiKey: string },
  method: string,
  path: string,
  body?: unknown,
  key: string | null = fake.apiKey,
): Promise<Answer> {
  const response = await fetch(`${fake.baseUrl}${path}`, {
    method,
    headers: {
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text === "" ? null : JSON.parse(text),
    headers: response.headers,
  };
}

async function seedPrice(fake: Awaited<ReturnType<typeof startTestPaddle>>) {
  const product = await call(fake, "POST", "/products", {
    name: "P",
    tax_category: "standard",
  });
  const price = await call(fake, "POST", "/prices", {
    product_id: product.json.data.id,
    description: "Monthly",
    unit_price: { amount: "1500", currency_code: "USD" },
    billing_cycle: { interval: "month", frequency: 1 },
    tax_mode: "internal",
  });
  return { product: product.json.data, price: price.json.data };
}

describe("a price PATCH of a money field", () => {
  // The research (§1) documents these fields as accepted by `PATCH /prices/{id}`; that Paddle locks them once a
  // price is in use is undocumented (S1). Refusing them is the app's own policy and lives in the client
  // (`updatePrice`, `price_field_immutable`), in front of the fake. The fake does not enforce it.
  // #436-T07
  it.each([
    ["unit_price", { amount: "1", currency_code: "USD" }],
    ["unit_price_overrides", []],
    ["billing_cycle", { interval: "year", frequency: 1 }],
    ["trial_period", { interval: "day", frequency: 7 }],
    ["tax_mode", "external"],
  ])("is accepted by the fake when it names %s", async (field, value) => {
    const fake = await startTestPaddle();
    const { price } = await seedPrice(fake);
    const answer = await call(fake, "PATCH", `/prices/${price.id}`, {
      [field]: value,
    });
    expect(answer.status).toBe(200);
    expect(answer.json.data[field]).toEqual(value);
  });

  // #436-T07
  it("is still checked against the documented shape", async () => {
    const fake = await startTestPaddle();
    const { price } = await seedPrice(fake);
    const answer = await call(fake, "PATCH", `/prices/${price.id}`, {
      unit_price: { amount: 1500 },
    });
    expect(answer.status).toBe(400);
    expect(answer.json.error.code).toBe("invalid_field");
    expect(fake.prices()).toEqual([price]);
  });

  // #436-T07
  it("never reaches the fake through the client: the app's guard refuses first", async () => {
    const fake = await startTestPaddle();
    const { price } = await seedPrice(fake);
    const before = fake.requests().length;
    const failure = await clientFor(fake)
      .updatePrice(price.id, { unit_price: { amount: "1" } } as never)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "price_field_immutable" });
    expect(fake.requests()).toHaveLength(before);
    expect(fake.prices()).toEqual([price]);
  });

  // #436-T07
  it("accepts the allowed fields", async () => {
    const fake = await startTestPaddle();
    const { price } = await seedPrice(fake);
    const answer = await call(fake, "PATCH", `/prices/${price.id}`, {
      name: "Renamed",
      description: "d",
      custom_data: { a: 1 },
      status: "archived",
    });
    expect(answer.status).toBe(200);
    expect(answer.json.data).toMatchObject({
      name: "Renamed",
      status: "archived",
      custom_data: { a: 1 },
    });
  });
});

describe("error codes of the fake", () => {
  // The research documents the shape of an error and a few codes; the names below were invented for the fake.
  // Callers must branch on the HTTP status and the documented constraint, not on these strings, until the
  // contract run against the sandbox (#448). A new code must be classified here.
  // #436-T07
  it("classifies every code it can answer as documented or unverified", () => {
    const source = readdirSync(FAKE_DIR)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(join(FAKE_DIR, file), "utf8"))
      .join("\n");
    const used = new Set<string>();
    for (const match of source.matchAll(
      /(?:conflict|fail|PaddleHttpError|errorBody)\(\s*(?:\d+,\s*)?"([a-z_]+)"/g,
    ))
      if (match[1] !== undefined) used.add(match[1]);
    for (const code of ["internal_error", "injected_fault"]) used.add(code);
    expect(used.size).toBeGreaterThan(8);
    const known = new Set<string>([
      ...DOCUMENTED_ERROR_CODES,
      ...UNVERIFIED_ERROR_CODES,
    ]);
    expect([...used].filter((code) => !known.has(code))).toEqual([]);
    expect(
      DOCUMENTED_ERROR_CODES.filter((code) =>
        (UNVERIFIED_ERROR_CODES as readonly string[]).includes(code),
      ),
    ).toEqual([]);
  });

  // #436-T07
  it("names the invented codes the review found, and none of the documented ones", () => {
    expect([...UNVERIFIED_ERROR_CODES]).toEqual(
      expect.arrayContaining([
        "price_field_immutable",
        "entity_archived",
        "invalid_request",
        "request_too_large",
        "authentication_missing",
        "internal_error",
        "injected_fault",
        "subscription_update_when_past_due",
        "subscription_locked_pending_changes",
        "subscription_locked_renewal",
      ]),
    );
  });
});

describe("authentication, validation and errors", () => {
  it("answers 403 without a key and with a wrong key, and records that it was not authenticated", async () => {
    const fake = await startTestPaddle();
    const none = await call(fake, "GET", "/products", undefined, null);
    expect(none.status).toBe(403);
    expect(none.json.error.code).toBe("authentication_missing");
    const wrong = await call(
      fake,
      "GET",
      "/products",
      undefined,
      "pdl_sdbx_apikey_wrong",
    );
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe("forbidden");
    expect(fake.requests().map((request) => request.authenticated)).toEqual([
      false,
      false,
    ]);
    expect(JSON.stringify(fake.requests())).not.toContain(
      "pdl_sdbx_apikey_wrong",
    );
  });

  it("validates bodies against the documented shapes with Paddle shaped errors", async () => {
    const fake = await startTestPaddle();
    const noName = await call(fake, "POST", "/products", {
      tax_category: "standard",
    });
    expect(noName.status).toBe(400);
    expect(noName.json.error).toMatchObject({
      type: "request_error",
      code: "invalid_field",
    });
    expect(noName.json.error.errors).toEqual([
      { field: "name", message: expect.any(String) },
    ]);
    expect(typeof noName.json.meta.request_id).toBe("string");

    const unknown = await call(fake, "POST", "/products", {
      name: "x",
      tax_category: "standard",
      color: "x",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.errors[0].field).toBe("color");

    const { product } = await seedPrice(fake);
    const badAmount = await call(fake, "POST", "/prices", {
      product_id: product.id,
      description: "d",
      unit_price: { amount: 15, currency_code: "usd" },
    });
    expect(badAmount.status).toBe(400);
    expect(
      badAmount.json.error.errors.map((e: { field: string }) => e.field),
    ).toEqual(["unit_price.amount", "unit_price.currency_code"]);

    const notJson = await fetch(`${fake.baseUrl}/products`, {
      method: "POST",
      headers: { authorization: `Bearer ${fake.apiKey}` },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
  });

  it("answers 404 for an unknown entity and an unknown route, 409 for a price on an archived product", async () => {
    const fake = await startTestPaddle();
    const missing = await call(
      fake,
      "GET",
      "/prices/pri_01fake99999999999999999999",
    );
    expect(missing.status).toBe(404);
    expect(missing.json.error).toMatchObject({
      type: "request_error",
      code: "not_found",
    });
    expect((await call(fake, "GET", "/nothing")).status).toBe(404);
    expect((await call(fake, "DELETE", "/prices/pri_1")).status).toBe(405);

    const { product } = await seedPrice(fake);
    await call(fake, "PATCH", `/products/${product.id}`, {
      status: "archived",
    });
    const conflict = await call(fake, "POST", "/prices", {
      product_id: product.id,
      description: "d",
      unit_price: { amount: "1", currency_code: "USD" },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("entity_archived");
  });

  it("makes entities with the fields of the sample fixtures", async () => {
    const fake = await startTestPaddle();
    const { product, price } = await seedPrice(fake);
    expect(Object.keys(product).sort()).toEqual(
      Object.keys(loadPaddleFixture("product")).sort(),
    );
    expect(Object.keys(price).sort()).toEqual(
      Object.keys(loadPaddleFixture("price")).sort(),
    );
    const transaction = await call(fake, "POST", "/transactions", {
      items: [{ price_id: price.id, quantity: 1 }],
    });
    expect(Object.keys(transaction.json.data).sort()).toEqual(
      Object.keys(loadPaddleFixture("transaction")).sort(),
    );
    const setting = await call(fake, "POST", "/notification-settings", {
      description: "d",
      type: "url",
      destination: "https://app.example.test/api/billing/webhook",
      subscribed_events: ["subscription.updated"],
    });
    expect(Object.keys(setting.json.data).sort()).toEqual(
      Object.keys(loadPaddleFixture("notification-setting")).sort(),
    );
  });
});

describe("transactions, subscriptions and the portal", () => {
  it("creates a transaction with a checkout link, keeps custom data and refuses an unknown price", async () => {
    const fake = await startTestPaddle();
    const { price } = await seedPrice(fake);
    const created = await call(fake, "POST", "/transactions", {
      items: [{ price_id: price.id, quantity: 1 }],
      custom_data: { workspace_id: "ws-1" },
    });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({
      status: "draft",
      custom_data: { workspace_id: "ws-1" },
      currency_code: "USD",
    });
    expect(created.json.data.checkout.url).toContain(
      `_ptxn=${created.json.data.id}`,
    );
    const unknown = await call(fake, "POST", "/transactions", {
      items: [{ price_id: "pri_01fake99999999999999999999", quantity: 1 }],
    });
    expect(unknown.status).toBe(404);
  });

  it("turns a paid transaction into a subscription of a customer", async () => {
    const fake = await startTestPaddle();
    const { price } = await seedPrice(fake);
    const txn = (
      await call(fake, "POST", "/transactions", {
        items: [{ price_id: price.id, quantity: 1 }],
        custom_data: { workspace_id: "ws-1" },
      })
    ).json.data;
    const subscription = fake.payTransaction(txn.id);
    expect(subscription).toMatchObject({
      status: "active",
      currency_code: "USD",
    });
    expect(subscription.items[0]?.price.id).toBe(price.id);
    // Whether Paddle copies the custom data of an API-made transaction is not documented (research S4).
    expect(subscription.custom_data).toBeNull();
    expect(fake.transactions()[0]).toMatchObject({
      status: "completed",
      customer_id: subscription.customer_id,
      subscription_id: subscription.id,
    });
    const other = await startTestPaddle({ copyTransactionCustomData: true });
    const { price: otherPrice } = await seedPrice(other);
    const otherTxn = (
      await call(other, "POST", "/transactions", {
        items: [{ price_id: otherPrice.id, quantity: 1 }],
        custom_data: { workspace_id: "ws-2" },
      })
    ).json.data;
    expect(other.payTransaction(otherTxn.id).custom_data).toEqual({
      workspace_id: "ws-2",
    });

    const got = await call(fake, "GET", `/subscriptions/${subscription.id}`);
    expect(got.json.data.id).toBe(subscription.id);
    const listed = await call(
      fake,
      "GET",
      `/subscriptions?customer_id=${subscription.customer_id}`,
    );
    expect(listed.json.data.map((s: { id: string }) => s.id)).toEqual([
      subscription.id,
    ]);
    expect(
      (
        await call(
          fake,
          "GET",
          "/subscriptions?customer_id=ctm_01fake99999999999999999999",
        )
      ).json.data,
    ).toEqual([]);
  });

  it("refuses an item swap in the states where Paddle does and allows it otherwise", async () => {
    const fake = await startTestPaddle();
    const { product, price } = await seedPrice(fake);
    const other = (
      await call(fake, "POST", "/prices", {
        product_id: product.id,
        description: "Other",
        unit_price: { amount: "3000", currency_code: "USD" },
        billing_cycle: { interval: "month", frequency: 1 },
      })
    ).json.data;
    const swap = {
      items: [{ price_id: other.id, quantity: 1 }],
      proration_billing_mode: "prorated_immediately",
    };

    const pastDue = fake.seedSubscription({
      priceId: price.id,
      status: "past_due",
    });
    const a = await call(fake, "PATCH", `/subscriptions/${pastDue.id}`, swap);
    expect([a.status, a.json.error.code]).toEqual([
      409,
      "subscription_update_when_past_due",
    ]);

    const renewing = fake.seedSubscription({
      priceId: price.id,
      nextBilledAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const b = await call(fake, "PATCH", `/subscriptions/${renewing.id}`, swap);
    expect([b.status, b.json.error.code]).toEqual([
      409,
      "subscription_locked_renewal",
    ]);

    const canceling = fake.seedSubscription({ priceId: price.id });
    await call(fake, "POST", `/subscriptions/${canceling.id}/cancel`, {});
    const c = await call(fake, "PATCH", `/subscriptions/${canceling.id}`, swap);
    expect([c.status, c.json.error.code]).toEqual([
      409,
      "subscription_locked_pending_changes",
    ]);

    const fine = fake.seedSubscription({ priceId: price.id });
    const noMode = await call(fake, "PATCH", `/subscriptions/${fine.id}`, {
      items: swap.items,
    });
    expect(noMode.status).toBe(400);
    const preview = await call(
      fake,
      "PATCH",
      `/subscriptions/${fine.id}/preview`,
      swap,
    );
    expect(preview.status).toBe(200);
    expect(preview.json.data.update_summary.result).toMatchObject({
      action: "charge",
      currency_code: "USD",
    });
    expect(
      fake.subscriptions().find((s) => s.id === fine.id)?.items[0]?.price.id,
    ).toBe(price.id);
    const done = await call(fake, "PATCH", `/subscriptions/${fine.id}`, swap);
    expect(done.status).toBe(200);
    expect(done.json.data.items[0].price.id).toBe(other.id);
  });

  it("cancels at the end of the period or at once", async () => {
    const fake = await startTestPaddle();
    const { price } = await seedPrice(fake);
    const sub = fake.seedSubscription({ priceId: price.id });
    const later = await call(
      fake,
      "POST",
      `/subscriptions/${sub.id}/cancel`,
      {},
    );
    expect(later.json.data.status).toBe("active");
    expect(later.json.data.scheduled_change).toMatchObject({
      action: "cancel",
      effective_at: sub.current_billing_period?.ends_at,
    });
    const now = await call(fake, "POST", `/subscriptions/${sub.id}/cancel`, {
      effective_from: "immediately",
    });
    expect(now.json.data.status).toBe("canceled");
    expect(now.json.data.canceled_at).not.toBeNull();
    expect(
      (await call(fake, "POST", `/subscriptions/${sub.id}/cancel`, {})).status,
    ).toBe(409);
  });

  it("makes a portal session for a known customer only", async () => {
    const fake = await startTestPaddle();
    const { price } = await seedPrice(fake);
    const sub = fake.seedSubscription({ priceId: price.id });
    const session = await call(
      fake,
      "POST",
      `/customers/${sub.customer_id}/portal-sessions`,
      {
        subscription_ids: [sub.id],
      },
    );
    expect(session.status).toBe(201);
    expect(session.json.data.urls.subscriptions[0].id).toBe(sub.id);
    expect(session.json.data.urls.general.overview).toMatch(/^https:\/\//);
    expect(
      (
        await call(
          fake,
          "POST",
          "/customers/ctm_01fake99999999999999999999/portal-sessions",
          {},
        )
      ).status,
    ).toBe(404);
  });

  it("creates a notification setting with a secret and gives it back by id", async () => {
    const fake = await startTestPaddle();
    const created = await call(fake, "POST", "/notification-settings", {
      description: "Billing",
      type: "url",
      destination: "https://app.example.test/api/billing/webhook",
      subscribed_events: ["subscription.updated", "price.created"],
    });
    expect(created.status).toBe(201);
    expect(created.json.data.endpoint_secret_key).toMatch(/^pdl_ntfset_/);
    expect(
      created.json.data.subscribed_events.map((e: { name: string }) => e.name),
    ).toEqual(["subscription.updated", "price.created"]);
    const got = await call(
      fake,
      "GET",
      `/notification-settings/${created.json.data.id}`,
    );
    expect(got.json.data.endpoint_secret_key).toBe(
      created.json.data.endpoint_secret_key,
    );
    const bad = await call(fake, "POST", "/notification-settings", {
      description: "x",
      type: "url",
      destination: "not a url",
      subscribed_events: [],
    });
    expect(bad.status).toBe(400);
  });
});

describe("fault injection", () => {
  it("applies a fault the given number of times and then behaves normally", async () => {
    const fake = await startTestPaddle();
    fake.faults.failWith({ method: "GET", path: "/products" }, 502, {
      times: 2,
    });
    expect((await call(fake, "GET", "/products")).status).toBe(502);
    expect((await call(fake, "GET", "/products")).status).toBe(502);
    expect((await call(fake, "GET", "/products")).status).toBe(200);
  });

  it("answers 429 with Retry-After and Paddle's error shape, without executing the request", async () => {
    const fake = await startTestPaddle();
    fake.faults.rateLimit(
      { method: "POST", path: "/products" },
      { retryAfterSeconds: 7 },
    );
    const limited = await call(fake, "POST", "/products", {
      name: "P",
      tax_category: "standard",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    expect(limited.json.error.type).toBe("request_error");
    expect(fake.products()).toEqual([]);
  });

  it("matches by method and by exact path or pattern, and clear() removes the faults", async () => {
    const fake = await startTestPaddle();
    fake.faults.failWith({ path: /^\/prices\// }, 500);
    expect((await call(fake, "GET", "/products")).status).toBe(200);
    expect((await call(fake, "GET", "/prices/pri_1")).status).toBe(500);
    fake.faults.failWith({ method: "GET", path: "/products" }, 500);
    fake.faults.clear();
    expect((await call(fake, "GET", "/products")).status).toBe(200);
  });

  it("executes a create before it drops the answer", async () => {
    const fake = await startTestPaddle();
    fake.faults.dropResponse(
      { method: "POST", path: "/products" },
      { mode: "reset" },
    );
    await expect(
      call(fake, "POST", "/products", { name: "P", tax_category: "standard" }),
    ).rejects.toThrow();
    expect(fake.products()).toHaveLength(1);
  });

  it("records every request without the key and forgets them on reset()", async () => {
    const fake = await startTestPaddle();
    await call(fake, "POST", "/products", {
      name: "P",
      tax_category: "standard",
    });
    await call(fake, "GET", "/products?status=archived");
    expect(fake.requests()).toMatchObject([
      {
        method: "POST",
        path: "/products",
        query: {},
        body: { name: "P", tax_category: "standard" },
        authenticated: true,
      },
      {
        method: "GET",
        path: "/products",
        query: { status: "archived" },
        authenticated: true,
      },
    ]);
    expect(JSON.stringify(fake.requests())).not.toContain(fake.apiKey);
    fake.reset();
    expect(fake.requests()).toEqual([]);
    expect(fake.products()).toEqual([]);
  });
});
