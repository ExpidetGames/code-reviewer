// SPDX-License-Identifier: Apache-2.0

// The client of the app against the fake Paddle over real HTTP on loopback (fakes/paddle): the same code that
// talks to Paddle in production, with the fake's faults in place of Paddle's bad days.
import { describe, expect, it } from "vitest";
import { clientFor, startTestPaddle } from "../test-support/paddle-fake.ts";
import {
  PaddleClientError,
  createPaddleClient,
  paddleBaseUrl,
} from "./paddle-client.ts";

const newProduct = { name: "Team plan", tax_category: "standard" };
const monthly = (productId: string, intent?: string) => ({
  product_id: productId,
  description: "Monthly",
  name: "Monthly",
  unit_price: { amount: "1500", currency_code: "USD" },
  billing_cycle: { interval: "month" as const, frequency: 1 },
  tax_mode: "internal" as const,
  ...(intent === undefined ? {} : { custom_data: { cr_intent: intent } }),
});

async function failureOf(
  promise: Promise<unknown>,
): Promise<PaddleClientError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaddleClientError);
  return error as PaddleClientError;
}

describe("products and prices", () => {
  // #436-T05
  it("creates and gets a product and a price and parses both", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake);

    const product = await client.createProduct({
      ...newProduct,
      custom_data: { cr_plan_key: "team" },
    });
    expect(product).toMatchObject({
      name: "Team plan",
      status: "active",
      custom_data: { cr_plan_key: "team" },
    });
    expect(product.id).toMatch(/^pro_/);
    expect(await client.getProduct(product.id)).toEqual(product);

    const price = await client.createPrice(monthly(product.id, "intent-1"));
    expect(price).toMatchObject({
      product_id: product.id,
      status: "active",
      tax_mode: "internal",
      unit_price: { amount: "1500", currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
      custom_data: { cr_intent: "intent-1" },
    });
    expect(price.id).toMatch(/^pri_/);
    expect(await client.getPrice(price.id)).toEqual(price);
  });

  // #436-T05
  it("lists prices with the product, status and recurring filters and pages through them", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake);
    const a = await client.createProduct(newProduct);
    const b = await client.createProduct({ ...newProduct, name: "Other" });
    const first = await client.createPrice(monthly(a.id));
    const second = await client.createPrice({
      ...monthly(a.id),
      billing_cycle: { interval: "year", frequency: 1 },
      unit_price: { amount: "15000", currency_code: "USD" },
    });
    const oneTime = await client.createPrice({
      product_id: a.id,
      description: "Setup",
      unit_price: { amount: "100", currency_code: "USD" },
    });
    const elsewhere = await client.createPrice(monthly(b.id));
    await client.updatePrice(second.id, { status: "archived" });

    const ids = async (query: Parameters<typeof client.listPrices>[0]) =>
      (await client.listPrices(query)).items.map((price) => price.id);

    expect(await ids({ product_id: [a.id] })).toEqual([first.id, oneTime.id]);
    expect(await ids({ product_id: [a.id], recurring: true })).toEqual([
      first.id,
    ]);
    expect(await ids({ product_id: [a.id], status: ["archived"] })).toEqual([
      second.id,
    ]);
    expect(
      await ids({ product_id: [a.id, b.id], status: ["active", "archived"] }),
    ).toEqual([first.id, second.id, oneTime.id, elsewhere.id]);
    expect(await ids({ id: [elsewhere.id] })).toEqual([elsewhere.id]);

    const pageOne = await client.listPrices({
      product_id: [a.id],
      per_page: 1,
    });
    expect(pageOne.items.map((price) => price.id)).toEqual([first.id]);
    expect(pageOne.nextAfter).not.toBeNull();
    const pageTwo = await client.listPrices({
      product_id: [a.id],
      per_page: 1,
      after: pageOne.nextAfter ?? "",
    });
    expect(pageTwo.items.map((price) => price.id)).toEqual([oneTime.id]);
    expect(pageTwo.nextAfter).toBeNull();
  });

  // #436-T05
  it("patches the name, description, custom data and archives a price", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake);
    const product = await client.createProduct(newProduct);
    const price = await client.createPrice(monthly(product.id));
    const patched = await client.updatePrice(price.id, {
      name: "Renamed",
      custom_data: { note: "x" },
    });
    expect(patched).toMatchObject({
      name: "Renamed",
      custom_data: { note: "x" },
    });
    expect(patched.unit_price).toEqual(price.unit_price);
    expect(
      (await client.updatePrice(price.id, { status: "archived" })).status,
    ).toBe("archived");
    const renamed = await client.updateProduct(product.id, {
      name: "Product 2",
    });
    expect(renamed.name).toBe("Product 2");
  });

  // #436-T06
  it("sends no request at all for a refused PATCH of a money field", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake);
    const product = await client.createProduct(newProduct);
    const price = await client.createPrice(monthly(product.id));
    const before = fake.requests().length;
    const failure = await failureOf(
      client.updatePrice(price.id, { unit_price: { amount: "1" } } as never),
    );
    expect(failure.code).toBe("price_field_immutable");
    expect(fake.requests()).toHaveLength(before);
  });
});

describe("lost responses", () => {
  // #436-T08
  it("reports a stable timeout code when the fake drops the answer after a create, and the price exists once", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake, { timeoutMs: 150 });
    const product = await client.createProduct(newProduct);

    fake.faults.dropResponse({ method: "POST", path: "/prices" });
    const failure = await failureOf(
      client.createPrice(monthly(product.id, "intent-9")),
    );
    expect(failure.code).toBe("timeout");
    expect(failure.status).toBeNull();

    const listed = await client.listPrices({ product_id: [product.id] });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.custom_data).toEqual({ cr_intent: "intent-9" });
  });

  // #436-T08
  it("reports network_error when the fake resets the connection after a create", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake, { timeoutMs: 2000 });
    const product = await client.createProduct(newProduct);
    fake.faults.dropResponse(
      { method: "POST", path: "/prices" },
      { mode: "reset" },
    );
    expect(
      (await failureOf(client.createPrice(monthly(product.id)))).code,
    ).toBe("network_error");
    expect(
      (await client.listPrices({ product_id: [product.id] })).items,
    ).toHaveLength(1);
  });

  // #436-T08
  it("reports timeout for an answer that comes after the limit", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake, { timeoutMs: 100 });
    fake.faults.delay({ method: "GET", path: "/products" }, 2000);
    expect((await failureOf(client.listProducts())).code).toBe("timeout");
    expect((await client.listProducts()).items).toEqual([]);
  });

  // #436-T08
  it("reports a 5xx once as server_error and succeeds on the next call", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake);
    fake.faults.failWith({ method: "GET", path: "/products" }, 503);
    const failure = await failureOf(client.listProducts());
    expect(failure).toMatchObject({ code: "server_error", status: 503 });
    expect((await client.listProducts()).items).toEqual([]);
  });
});

describe("rate limits", () => {
  // #436-T09
  it("honours Retry-After and succeeds on the third try", async () => {
    const fake = await startTestPaddle();
    const waits: number[] = [];
    const client = clientFor(fake, {
      sleep: (ms) => (waits.push(ms), Promise.resolve()),
    });
    fake.faults.rateLimit(
      { method: "GET", path: "/products" },
      { retryAfterSeconds: 2, times: 2 },
    );
    await client.listProducts();
    expect(waits).toEqual([2000, 2000]);
    expect(
      fake.requests().filter((request) => request.path === "/products"),
    ).toHaveLength(3);
  });

  // #436-T09
  it("stops after a bounded number of tries", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake, { maxRateLimitRetries: 2 });
    fake.faults.rateLimit(
      { method: "GET", path: "/products" },
      { retryAfterSeconds: 1, times: 10 },
    );
    const failure = await failureOf(client.listProducts());
    expect(failure).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterSeconds: 1,
    });
    expect(fake.requests()).toHaveLength(3);
  });
});

describe("Paddle errors", () => {
  // #436-T10
  it("maps Paddle's error shape to a stable code and keeps no body in the message", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake);

    const missing = await failureOf(
      client.getPrice("pri_01fake99999999999999999999"),
    );
    expect(missing).toMatchObject({
      code: "not_found",
      status: 404,
      paddleCode: "not_found",
    });
    expect(missing.message).not.toMatch(/Entity .* not found/);

    const invalid = await failureOf(
      client.createProduct({ name: "", tax_category: "standard" }),
    );
    expect(invalid).toMatchObject({
      code: "bad_request",
      status: 400,
      paddleCode: "invalid_field",
    });

    const product = await client.createProduct(newProduct);
    await client.updateProduct(product.id, { status: "archived" });
    const conflict = await failureOf(client.createPrice(monthly(product.id)));
    expect(conflict).toMatchObject({
      code: "conflict",
      status: 409,
      paddleCode: "entity_archived",
    });
    for (const failure of [missing, invalid, conflict])
      expect(failure.message).not.toMatch(
        /archived|required|not found|detail/i,
      );
  });

  // #436-T10
  it("maps a wrong key to unauthorized or forbidden without echoing it", async () => {
    const fake = await startTestPaddle();
    const wrongKey = "pdl_sdbx_apikey_not_the_key_of_the_fake";
    const client = createPaddleClient({
      apiKey: wrongKey,
      baseUrl: fake.baseUrl,
    });
    const failure = await failureOf(client.listProducts());
    expect(failure.code).toBe("forbidden");
    expect(failure.message).not.toContain(wrongKey);
    expect(fake.requests()[0]?.authenticated).toBe(false);
    expect(JSON.stringify(fake.requests())).not.toContain(wrongKey);
  });
});

describe("notification settings", () => {
  const destination = "https://app.example.test/api/billing/webhook";
  const input = (url: string) => ({
    description: "Code Reviewer",
    destination: url,
    subscribed_events: ["subscription.updated"],
  });

  // #437-T05
  it("lists the destinations with their secret and deletes one by id", async () => {
    const fake = await startTestPaddle();
    const client = clientFor(fake);
    const first = await client.createNotificationSetting(input(destination));
    const second = await client.createNotificationSetting(
      input("https://other.example.test/hook"),
    );

    const listed = await client.listNotificationSettings();

    expect(listed.map(({ id }) => id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(listed.find(({ id }) => id === first.id)).toMatchObject({
      destination,
      endpoint_secret_key: first.endpoint_secret_key,
    });

    await client.deleteNotificationSetting(first.id);

    expect(
      (await client.listNotificationSettings()).map(({ id }) => id),
    ).toEqual([second.id]);
    expect(
      (await failureOf(client.deleteNotificationSetting(first.id))).code,
    ).toBe("not_found");
  });
});

describe("no real network", () => {
  // #436-T11
  it("cannot reach the real Paddle from a test: the network guard blocks it", async () => {
    const client = createPaddleClient({
      apiKey: "pdl_live_apikey_dummy_for_tests",
      baseUrl: paddleBaseUrl("live"),
      timeoutMs: 2000,
    });
    expect((await failureOf(client.listProducts())).code).toBe("network_error");
  });
});
