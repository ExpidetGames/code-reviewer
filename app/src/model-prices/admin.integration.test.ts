// SPDX-License-Identifier: Apache-2.0

// The catalog price routes of the admin portal (#549), end to end over a real database, the real access proxy and the real
// handlers: only an instance admin gets in, every change comes from this site and is JSON, enabling, confirming and
// correcting work through HTTP with stable error codes, the audit line names the person and the prices, and nothing of it
// is reachable from a workspace.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import {
  MISSING_ANSWER_MARKER,
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import type { StoredModel, StoredProvider } from "../models-dev/catalog.ts";
import { MODEL_PRICE_ROUTE_ERROR_CODES } from "./admin-errors.ts";
import { MODEL_PRICE_ERROR_CODES } from "./errors.ts";

const BASE = "/api/admin/catalog-models";
const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };
const T = "2026-10-20T08:00:00.000Z";

const provider: StoredProvider = {
  id: "deepseek",
  name: "DeepSeek",
  url: {
    state: "trusted",
    trustedUrl: "https://api.deepseek.com",
    pendingUrl: null,
    problem: null,
  },
  urlChangedAt: null,
  firstSeenAt: T,
  unlistedAt: null,
  updatedAt: T,
};
const model: StoredModel = {
  providerId: "deepseek",
  id: "deepseek-v4-pro",
  name: "DeepSeek V4 Pro",
  family: null,
  limit: { context: 1000000, output: 384000 },
  reasoning: true,
  temperature: true,
  attachment: false,
  modalities: { input: ["text"], output: ["text"] },
  status: null,
  cost: { input: "0.6", output: "1.2", cacheRead: "0.06" },
  lastUpdated: null,
  interleaved: null,
  firstSeenAt: T,
  unlistedAt: null,
  updatedAt: T,
};
const IDS = { providerId: "deepseek", modelId: "deepseek-v4-pro" };

async function start() {
  const portal = await createAdminHarness();
  await createModelsDevRepository(portal.db).apply({
    providers: [provider],
    models: [model],
  });
  return portal;
}

function call(
  portal: AdminHarness,
  method: string,
  path: string,
  body?: unknown,
  cookies = portal.adminCookies,
  headers?: Record<string, string>,
) {
  return portal.visit(`${BASE}${path}`, {
    method,
    cookies,
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
  });
}

type View = {
  enabled: boolean | null;
  price: { status: string; reference: { hash: string } };
  managed: { selectable: boolean; reason: string | null };
};

async function viewOf(portal: AdminHarness): Promise<View> {
  const response = await call(portal, "GET", "");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { models: View[] };
  return body.models[0] as View;
}

function isHidden(response: Response): boolean {
  return (
    response.status === 404 &&
    response.headers.get(MISSING_ANSWER_MARKER) === "1"
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

const WRITES: Array<{ method: string; path: string; body: unknown }> = [
  { method: "POST", path: "/enablement", body: { ...IDS, enabled: true } },
  {
    method: "POST",
    path: "/price/confirm",
    body: { ...IDS, referenceHash: "a".repeat(64) },
  },
  {
    method: "POST",
    path: "/price/correct",
    body: {
      ...IDS,
      referenceHash: "a".repeat(64),
      price: { input: "1", output: "2" },
      reason: "Invoice.",
    },
  },
];
const ROUTES = [{ method: "GET", path: "", body: undefined }, ...WRITES];

describe("who may use the catalog price routes", () => {
  // #549-T08
  it.each(ROUTES)(
    "gives 401 to a visitor without a session on $method /catalog-models$path",
    async ({ method, path, body }) => {
      const portal = await start();

      const response = await call(portal, method, path, body, new Map());

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
      expect(
        await portal.modelPrices.get("deepseek", "deepseek-v4-pro"),
      ).toMatchObject({
        ok: true,
        model: { enabled: null, price: { status: "unconfirmed" } },
      });
    },
  );

  // #549-T08
  it.each(ROUTES)(
    "hides $method /catalog-models$path from a signed in person who is not an admin, with and without the proxy, and shows no data",
    async ({ method, path, body }) => {
      const portal = await start();
      await portal.createUser({ id: "member-1", ...MEMBER });
      const member = await portal.signIn(MEMBER.email, MEMBER.password);

      const proxied = await call(portal, method, path, body, member);
      const direct = await portal.callRoute(
        `/api/instance-portal/catalog-models${path}`,
        { method, cookies: member, ...(body === undefined ? {} : { body }) },
      );

      expect(isHidden(proxied)).toBe(true);
      expect(direct.status).toBe(404);
      expect(await proxied.text()).not.toContain("deepseek");
      expect(portal.modelPriceLog).toEqual([]);
    },
  );

  // #549-T08
  it.each(WRITES)(
    "refuses $method /catalog-models$path from another site, a body that is not JSON and a body over 64 KB",
    async ({ method, path, body }) => {
      const portal = await start();

      const crossSite = await call(portal, method, path, body, undefined, {
        "sec-fetch-site": "cross-site",
      });
      const plain = await call(portal, method, path, "x=1", undefined, {
        "content-type": "text/plain",
      });
      const huge = await call(
        portal,
        method,
        path,
        JSON.stringify({ reason: "x".repeat(70 * 1024) }),
        undefined,
        { "content-type": "application/json" },
      );

      expect(crossSite.status).toBe(403);
      expect(await crossSite.json()).toEqual({ error: "cross_site_request" });
      expect(plain.status).toBe(415);
      expect(huge.status).toBe(413);
      expect(portal.modelPriceLog).toEqual([]);
    },
  );
});

describe("the list", () => {
  // #549-T02
  it("shows the models with their price status, sources and the hash to confirm, and is never cached", async () => {
    const portal = await start();

    const response = await call(portal, "GET", "");
    const body = (await response.json()) as {
      models: Array<Record<string, unknown>>;
      total: number;
      newCount: number;
      fetch: unknown;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.total).toBe(1);
    expect(body.newCount).toBe(0);
    expect(body.models[0]).toMatchObject({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      enabled: null,
      price: {
        status: "unconfirmed",
        book: { input: "600000", output: "1200000", cacheRead: "60000" },
        sources: { input: "catalog", cacheWrite1h: null },
      },
      managed: { selectable: false, reason: "model_not_enabled" },
    });
  });

  // #549-T02
  it("filters by the documented query and refuses an unknown or malformed one", async () => {
    const portal = await start();

    const hit = await call(
      portal,
      "GET",
      "?provider=deepseek&search=V4&priceStatus=unconfirmed&enabled=undecided&limit=5",
    );
    const miss = await call(portal, "GET", "?search=nothing-like-it");
    expect(((await hit.json()) as { total: number }).total).toBe(1);
    expect(((await miss.json()) as { total: number }).total).toBe(0);

    for (const query of [
      "?priceStatus=free",
      "?enabled=maybe",
      "?limit=abc",
      "?limit=100000",
      "?offset=-1",
      "?sort=name",
    ]) {
      const bad = await call(portal, "GET", query);
      expect(bad.status, query).toBe(422);
      expect(((await bad.json()) as { error: string }).error).toBe(
        "request_invalid",
      );
    }
  });
});

describe("enabling, confirming and correcting through the routes", () => {
  // #549-T04
  it("enables a model, confirms the price as shown, and then the managed key may use it", async () => {
    const portal = await start();

    const enabled = await call(portal, "POST", "/enablement", {
      ...IDS,
      enabled: true,
    });
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as { model: View }).model).toMatchObject({
      enabled: true,
      managed: { selectable: false, reason: "price_unconfirmed" },
    });
    const confirmed = await call(portal, "POST", "/price/confirm", {
      ...IDS,
      referenceHash: (await viewOf(portal)).price.reference.hash,
    });

    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as { model: View }).model).toMatchObject({
      price: { status: "confirmed" },
      managed: { selectable: true, reason: null },
    });
    expect(
      await portal.modelPrices.availability("deepseek", "deepseek-v4-pro"),
    ).toMatchObject({ selectable: true });
  });

  // #549-T04
  it("corrects the price with a reason", async () => {
    const portal = await start();
    const shown = await viewOf(portal);

    const response = await call(portal, "POST", "/price/correct", {
      ...IDS,
      referenceHash: shown.price.reference.hash,
      price: { input: "700000", output: "1200000", cacheRead: null },
      reason: "Invoice of October.",
    });

    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { model: Record<string, unknown> }).model,
    ).toMatchObject({
      price: {
        status: "confirmed",
        book: { input: "700000" },
        sources: { input: "admin", output: "catalog" },
        confirmation: { source: "admin", reason: "Invoice of October." },
      },
    });
  });

  // #549-T10
  it.each([
    [
      "an unknown model",
      "/enablement",
      { providerId: "deepseek", modelId: "nobody", enabled: true },
      404,
      "model_unknown",
      undefined,
    ],
    [
      "a body with a missing flag",
      "/enablement",
      IDS,
      422,
      "request_invalid",
      undefined,
    ],
    [
      "a forged workspace in the body",
      "/enablement",
      { ...IDS, enabled: true, workspaceId: "w-1" },
      422,
      "request_invalid",
      undefined,
    ],
    [
      "a price the admin did not see",
      "/price/confirm",
      { ...IDS, referenceHash: "b".repeat(64) },
      409,
      "price_changed",
      undefined,
    ],
    [
      "a negative price",
      "/price/correct",
      {
        ...IDS,
        referenceHash: "b".repeat(64),
        price: { input: "-1", output: "2" },
        reason: "x",
      },
      422,
      "price_invalid",
      "price",
    ],
    [
      "a correction without a reason",
      "/price/correct",
      {
        ...IDS,
        referenceHash: "b".repeat(64),
        price: { input: "1", output: "2" },
        reason: "",
      },
      422,
      "reason_invalid",
      "reason",
    ],
  ])(
    "answers %s with a stable code and writes nothing",
    async (_name, path, body, status, code, field) => {
      const portal = await start();

      const response = await call(portal, "POST", path, body);

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: code,
        ...(field === undefined ? {} : { issues: [{ field, code }] }),
      });
      expect(portal.modelPriceLog).toEqual([]);
      expect((await viewOf(portal)).enabled).toBeNull();
    },
  );

  // #549-T10
  it("has a status for every code the service can answer with", () => {
    for (const code of MODEL_PRICE_ERROR_CODES)
      expect(MODEL_PRICE_ROUTE_ERROR_CODES).toContain(code);
  });

  // #549-T09
  it("writes one audit line for each write, with the signed in person and the prices, and no cookie or key", async () => {
    const portal = await start();
    await call(portal, "POST", "/enablement", { ...IDS, enabled: true });
    await call(portal, "POST", "/price/confirm", {
      ...IDS,
      referenceHash: (await viewOf(portal)).price.reference.hash,
    });

    expect(portal.modelPriceLog).toHaveLength(2);
    expect(portal.modelPriceLog[0]).toBe(
      `model prices: MODEL_ENABLED by=${portal.adminId} model=deepseek/deepseek-v4-pro`,
    );
    expect(portal.modelPriceLog[1]).toContain(
      `PRICE_CONFIRMED by=${portal.adminId} model=deepseek/deepseek-v4-pro`,
    );
    expect(portal.modelPriceLog[1]).toContain('"input":"600000"');
    const all = portal.modelPriceLog.join("\n").toLowerCase();
    for (const secret of [
      "cookie",
      "session",
      "password",
      "authorization",
      "secret",
    ])
      expect(all).not.toContain(secret);
  });

  // #549-T08
  it("answers a database that cannot be read with 503 and no detail", async () => {
    const portal = await start();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(portal.modelPrices, "list").mockRejectedValue(
      new Error("deepseek-v4-pro password=hunter2"),
    );

    const response = await call(portal, "GET", "");

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("hunter2");
  });
});
