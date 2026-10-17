// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { loadPaddleFixture } from "../../../fakes/paddle/fixtures.ts";
import {
  PADDLE_CLIENT_ERROR_CODES,
  PADDLE_IMMUTABLE_PRICE_FIELDS,
  PaddleClientError,
  createPaddleClient,
  paddleBaseUrl,
  paddleKeyEnvironment,
  type PaddleClientOptions,
} from "./paddle-client.ts";

const API_KEY = "pdl_sdbx_apikey_dummyvalue_for_tests";
const PRICE_ID = "pri_01fake00000000000000000001";

type Call = { url: string; init: RequestInit };

/** A client whose fetch answers from `reply`, and the calls it received. */
function stubbed(
  reply: (call: Call) => Response | Promise<Response>,
  overrides: Partial<PaddleClientOptions> = {},
) {
  const calls: Call[] = [];
  const client = createPaddleClient({
    apiKey: API_KEY,
    baseUrl: "http://paddle.invalid",
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return reply(call);
    },
    sleep: () => Promise.resolve(),
    ...overrides,
  });
  return { client, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PaddleClientError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("the money guardrail", () => {
  // #436-T06
  it.each(PADDLE_IMMUTABLE_PRICE_FIELDS)(
    "refuses a PATCH of %s before any request is sent",
    async (field) => {
      const { client, calls } = stubbed(() => json({ data: {} }));
      const patch = { [field]: "anything" };
      expect(await codeOf(client.updatePrice(PRICE_ID, patch))).toBe(
        "price_field_immutable",
      );
      expect(calls).toHaveLength(0);
    },
  );

  // #436-T06
  it("names exactly the five money fields", () => {
    expect([...PADDLE_IMMUTABLE_PRICE_FIELDS].sort()).toEqual([
      "billing_cycle",
      "tax_mode",
      "trial_period",
      "unit_price",
      "unit_price_overrides",
    ]);
  });

  // #436-T06
  it("refuses a PATCH that mixes an allowed field with a money field", async () => {
    const { client, calls } = stubbed(() => json({ data: {} }));
    const patch = { name: "New name", unit_price: { amount: "1" } };
    expect(await codeOf(client.updatePrice(PRICE_ID, patch))).toBe(
      "price_field_immutable",
    );
    expect(calls).toHaveLength(0);
  });

  // #436-T06
  it("refuses a field it does not know and any status but archived", async () => {
    const { client, calls } = stubbed(() => json({ data: {} }));
    expect(await codeOf(client.updatePrice(PRICE_ID, { quantity: 5 }))).toBe(
      "price_field_immutable",
    );
    expect(
      await codeOf(client.updatePrice(PRICE_ID, { status: "active" })),
    ).toBe("price_field_immutable");
    expect(
      await codeOf(client.updatePrice(PRICE_ID, { unit_price: undefined })),
    ).toBe("price_field_immutable");
    expect(calls).toHaveLength(0);
  });

  // #436-T06
  it("sends a PATCH of name, description, custom_data and archived", async () => {
    const { client, calls } = stubbed(() =>
      json({ data: loadPaddleFixture("price") }),
    );
    await client.updatePrice(PRICE_ID, {
      name: "Renamed",
      description: "New text",
      custom_data: { cr_plan_key: "team" },
      status: "archived",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(`http://paddle.invalid/prices/${PRICE_ID}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      name: "Renamed",
      description: "New text",
      custom_data: { cr_plan_key: "team" },
      status: "archived",
    });
  });
});

describe("requests", () => {
  it("sends the key as a bearer token, JSON, no redirect following and no cache", async () => {
    const { client, calls } = stubbed(() =>
      json({ data: loadPaddleFixture("price") }),
    );
    await client.getPrice(PRICE_ID);
    const init = calls[0]?.init;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
  });

  it("joins list filters the way Paddle reads them", async () => {
    const { client, calls } = stubbed(() =>
      json({
        data: [],
        meta: { pagination: { per_page: 50, next: "", has_more: false } },
      }),
    );
    await client.listPrices({
      product_id: ["pro_a", "pro_b"],
      status: ["active", "archived"],
      recurring: true,
      per_page: 10,
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/prices");
    expect(url.searchParams.get("product_id")).toBe("pro_a,pro_b");
    expect(url.searchParams.get("status")).toBe("active,archived");
    expect(url.searchParams.get("recurring")).toBe("true");
    expect(url.searchParams.get("per_page")).toBe("10");
  });

  it("refuses an id that is not a Paddle id without sending anything", async () => {
    const { client, calls } = stubbed(() => json({ data: {} }));
    for (const id of ["../subscriptions", "pri_a/b", "", "pri a", "pri_a?x=1"])
      expect(await codeOf(client.getPrice(id)), id).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  it("uses the sandbox and live addresses of Paddle", () => {
    expect(paddleBaseUrl("sandbox")).toBe("https://sandbox-api.paddle.com");
    expect(paddleBaseUrl("live")).toBe("https://api.paddle.com");
  });

  it("reads only the environment prefix of a key", () => {
    expect(paddleKeyEnvironment("pdl_sdbx_apikey_abc")).toBe("sandbox");
    expect(paddleKeyEnvironment("pdl_live_apikey_abc")).toBe("live");
    expect(paddleKeyEnvironment("something-else")).toBeNull();
    expect(paddleKeyEnvironment("")).toBeNull();
  });

  it("refuses a missing key or an address that is not http(s) at construction", () => {
    const base = { apiKey: API_KEY, baseUrl: "http://paddle.invalid" };
    for (const bad of [
      { ...base, apiKey: "" },
      { ...base, baseUrl: "not a url" },
      { ...base, baseUrl: "file:///etc/passwd" },
    ])
      expect(() => createPaddleClient(bad)).toThrow(PaddleClientError);
  });
});

describe("responses", () => {
  // #436-T05
  it("parses the sample entities and ignores the fields it does not use", async () => {
    const price = loadPaddleFixture("price");
    const { client } = stubbed(() =>
      json({ data: { ...price, surprise: "x" } }),
    );
    const parsed = await client.getPrice(PRICE_ID);
    expect(parsed).toMatchObject({
      id: price.id,
      product_id: price.product_id,
      status: "active",
      tax_mode: "internal",
      unit_price: { amount: "1234", currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
    });
    expect(parsed).not.toHaveProperty("surprise");
    expect(parsed).not.toHaveProperty("import_meta");
  });

  // #436-T05
  it("parses every other sample entity", async () => {
    const cases = [
      [
        "product",
        (c: ReturnType<typeof stubbed>["client"]) =>
          c.getProduct("pro_01fake00000000000000000001"),
      ],
      [
        "subscription",
        (c: ReturnType<typeof stubbed>["client"]) =>
          c.getSubscription("sub_01fake00000000000000000001"),
      ],
      [
        "notification-setting",
        (c: ReturnType<typeof stubbed>["client"]) =>
          c.getNotificationSetting("ntfset_01fake00000000000000000001"),
      ],
    ] as const;
    for (const [name, call] of cases) {
      const { client } = stubbed(() => json({ data: loadPaddleFixture(name) }));
      const parsed = (await call(client)) as { id: string };
      expect(parsed.id, name).toBe(loadPaddleFixture(name).id);
    }
  });

  // #436-T10
  it("refuses a response that does not fit the schema", async () => {
    const { client } = stubbed(() =>
      json({ data: { id: "pri_1", unit_price: "free" } }),
    );
    expect(await codeOf(client.getPrice(PRICE_ID))).toBe("invalid_response");
    const html = stubbed(
      () => new Response("<html>hi</html>", { status: 200 }),
    );
    expect(await codeOf(html.client.getPrice(PRICE_ID))).toBe(
      "invalid_response",
    );
  });

  // #436-T10
  it("maps an HTTP status to one stable code and keeps the Paddle error code", async () => {
    const expected: Array<[number, string]> = [
      [400, "bad_request"],
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [409, "conflict"],
      [418, "rejected"],
      [500, "server_error"],
      [503, "server_error"],
    ];
    for (const [status, code] of expected) {
      const { client } = stubbed(() =>
        json(
          {
            error: {
              type: "request_error",
              code: "some_paddle_code",
              detail: "SECRET-DETAIL",
            },
          },
          { status },
        ),
      );
      const error = await client.getPrice(PRICE_ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PaddleClientError);
      const failure = error as PaddleClientError;
      expect(failure.code, String(status)).toBe(code);
      expect(failure.status).toBe(status);
      expect(failure.paddleCode).toBe("some_paddle_code");
      expect(failure.message).not.toContain("SECRET-DETAIL");
    }
  });

  // #436-T10
  it("keeps no body, no key and no odd Paddle code in an error", async () => {
    const { client } = stubbed(() =>
      json(
        { error: { type: "x", code: `bad code ${API_KEY}`, detail: "d" } },
        { status: 400 },
      ),
    );
    const error = (await client
      .getPrice(PRICE_ID)
      .catch((e: unknown) => e)) as PaddleClientError;
    expect(error.paddleCode).toBeNull();
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(error.message).not.toContain(API_KEY);
    const plain = stubbed(
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    const bad = (await plain.client
      .getPrice(PRICE_ID)
      .catch((e: unknown) => e)) as PaddleClientError;
    expect(bad.code).toBe("server_error");
    expect(bad.paddleCode).toBeNull();
    expect(bad.message).not.toContain("bad gateway");
  });

  // #436-T10
  it("never puts the key in the error of a failed connection", async () => {
    const { client } = stubbed(() => {
      throw new Error(`connect failed, header was Bearer ${API_KEY}`);
    });
    const error = (await client
      .getPrice(PRICE_ID)
      .catch((e: unknown) => e)) as PaddleClientError;
    expect(error.code).toBe("network_error");
    expect(error.message).not.toContain(API_KEY);
    expect(String(error.cause ?? "")).not.toContain(API_KEY);
  });

  it("has a closed list of codes", () => {
    expect([...PADDLE_CLIENT_ERROR_CODES].sort()).toEqual([
      "bad_request",
      "conflict",
      "forbidden",
      "invalid_argument",
      "invalid_configuration",
      "invalid_response",
      "network_error",
      "not_found",
      "price_field_immutable",
      "rate_limited",
      "rejected",
      "server_error",
      "timeout",
      "unauthorized",
    ]);
  });
});

describe("rate limits", () => {
  const limited = (retryAfter: string | null) => () =>
    new Response("{}", {
      status: 429,
      headers: retryAfter === null ? {} : { "retry-after": retryAfter },
    });

  // #436-T09
  it("waits for Retry-After and tries again, within a bounded number of tries", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const { client, calls } = stubbed(
      () =>
        ++attempts < 3
          ? limited("2")()
          : json({ data: loadPaddleFixture("price") }),
      { sleep: (ms) => (waits.push(ms), Promise.resolve()) },
    );
    await client.getPrice(PRICE_ID);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([2000, 2000]);
  });

  // #436-T09
  it("gives up with rate_limited after the last try and says how long Paddle asked to wait", async () => {
    const { client, calls } = stubbed(limited("3"), { maxRateLimitRetries: 2 });
    const error = (await client
      .getPrice(PRICE_ID)
      .catch((e: unknown) => e)) as PaddleClientError;
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(3);
    expect(calls).toHaveLength(3);
  });

  // #436-T09
  it("does not wait longer than the cap: it reports at once", async () => {
    const waits: number[] = [];
    const { client, calls } = stubbed(limited("3600"), {
      maxRetryAfterSeconds: 30,
      sleep: (ms) => (waits.push(ms), Promise.resolve()),
    });
    const error = (await client
      .getPrice(PRICE_ID)
      .catch((e: unknown) => e)) as PaddleClientError;
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(3600);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  // #436-T09
  it("waits a short default when Retry-After is missing or unreadable", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const { client } = stubbed(
      () =>
        ++attempts < 3
          ? limited(attempts === 1 ? null : "soon")()
          : json({ data: loadPaddleFixture("price") }),
      { sleep: (ms) => (waits.push(ms), Promise.resolve()) },
    );
    await client.getPrice(PRICE_ID);
    expect(waits).toEqual([1000, 1000]);
  });

  // #436-T09
  it("never retries anything but a 429: a 500 on a create is reported once", async () => {
    const { client, calls } = stubbed(
      () => new Response("{}", { status: 500 }),
    );
    expect(
      await codeOf(
        client.createPrice({
          product_id: "pro_1",
          description: "d",
          unit_price: { amount: "1", currency_code: "USD" },
        }),
      ),
    ).toBe("server_error");
    expect(calls).toHaveLength(1);
  });
});

describe("timeouts", () => {
  // #436-T08
  it("reports timeout when no answer comes within the limit", async () => {
    const { client } = stubbed(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
      { timeoutMs: 20 },
    );
    expect(await codeOf(client.getPrice(PRICE_ID))).toBe("timeout");
  });
});
