// SPDX-License-Identifier: Apache-2.0

// The routes of the models.dev catalog in the admin portal (#554), end to end over a real database, the real access proxy
// and the real handlers: only an instance admin gets in, every change comes from this site and is JSON, the confirmation of
// an address and "fetch now" work through HTTP with stable error codes, "fetch now" is limited and passes a deadline below
// the function limit of the route, and nothing is reachable from a workspace.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import {
  MISSING_ANSWER_MARKER,
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import {
  MODELS_DEV_ADMIN_ERROR_CODES,
  MODELS_DEV_ADMIN_ERROR_STATUS,
} from "./admin-errors.ts";
import { FETCH_NOW_DEADLINE_MS, FETCH_NOW_MAX } from "./admin-service.ts";
import type { StoredProvider } from "./catalog.ts";

const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };
const T = "2026-10-20T08:00:00.000Z";
const MOVED = "https://api.deepseek.moved.example/v1";

const changed: StoredProvider = {
  id: "deepseek",
  name: "DeepSeek",
  url: {
    state: "url_changed",
    trustedUrl: "https://api.deepseek.com",
    pendingUrl: MOVED,
    problem: null,
  },
  urlChangedAt: T,
  firstSeenAt: T,
  unlistedAt: null,
  updatedAt: T,
};
const refused: StoredProvider = {
  ...changed,
  id: "xai",
  name: "xAI",
  url: {
    state: "url_changed",
    trustedUrl: "https://api.x.ai/v1",
    pendingUrl: "http://169.254.169.254/latest",
    problem: "not_https",
  },
};

async function start() {
  const portal = await createAdminHarness();
  await createModelsDevRepository(portal.db).apply({
    providers: [changed, refused],
    models: [],
  });
  return portal;
}

const ROUTES = [
  { method: "GET", path: "/catalog-providers", body: undefined },
  {
    method: "POST",
    path: "/catalog-providers/url/confirm",
    body: { providerId: "deepseek", pendingUrl: MOVED },
  },
  { method: "POST", path: "/catalog-fetch", body: {} },
] as const;
const WRITES = ROUTES.filter((route) => route.method === "POST");

function call(
  portal: AdminHarness,
  method: string,
  path: string,
  body?: unknown,
  cookies = portal.adminCookies,
  headers?: Record<string, string>,
) {
  return portal.visit(`/api/admin${path}`, {
    method,
    cookies,
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
  });
}

function isHidden(response: Response): boolean {
  return (
    response.status === 404 &&
    response.headers.get(MISSING_ANSWER_MARKER) === "1"
  );
}

describe("who may use the catalog routes", () => {
  // #554-T09
  it.each(ROUTES)(
    "gives 401 to a visitor without a session on $method $path",
    async ({ method, path, body }) => {
      const portal = await start();

      const response = await call(portal, method, path, body, new Map());

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
      expect(portal.modelsDevFetch.calls).toEqual([]);
      expect(
        (await createModelsDevRepository(portal.db).getProvider("deepseek"))
          ?.url.state,
      ).toBe("url_changed");
    },
  );

  // #554-T09
  it.each(ROUTES)(
    "hides $method $path from a signed in person who is not an admin, with and without the proxy, and shows no data",
    async ({ method, path, body }) => {
      const portal = await start();
      await portal.createUser({ id: "member-1", ...MEMBER });
      const member = await portal.signIn(MEMBER.email, MEMBER.password);

      const proxied = await call(portal, method, path, body, member);
      const direct = await portal.callRoute(`/api/instance-portal${path}`, {
        method,
        cookies: member,
        ...(body === undefined ? {} : { body }),
      });

      expect(isHidden(proxied)).toBe(true);
      expect(direct.status).toBe(404);
      expect(await proxied.text()).not.toContain("deepseek");
      expect(portal.modelsDevFetch.calls).toEqual([]);
      expect(portal.modelsDevLog).toEqual([]);
    },
  );

  // #554-T09
  it.each(WRITES)(
    "refuses $method $path from another site, a body that is not JSON and a body over 4 KB",
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
        JSON.stringify({ providerId: "x".repeat(5 * 1024) }),
        undefined,
        { "content-type": "application/json" },
      );

      expect(crossSite.status).toBe(403);
      expect(await crossSite.json()).toEqual({ error: "cross_site_request" });
      expect(plain.status).toBe(415);
      expect(huge.status).toBe(413);
      expect(portal.modelsDevFetch.calls).toEqual([]);
      expect(portal.modelsDevLog).toEqual([]);
    },
  );
});

describe("the providers", () => {
  // #554-T06
  it("lists every provider with the old and the new address and the problem of a refused one, and is never cached", async () => {
    const portal = await start();

    const response = await call(portal, "GET", "/catalog-providers");
    const body = (await response.json()) as {
      providers: Array<{ id: string; url: Record<string, unknown> }>;
      fetchEnabled: boolean;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.fetchEnabled).toBe(true);
    expect(body.providers.map((p) => [p.id, p.url])).toEqual([
      [
        "deepseek",
        {
          state: "url_changed",
          trustedUrl: "https://api.deepseek.com",
          pendingUrl: MOVED,
          problem: null,
        },
      ],
      [
        "xai",
        {
          state: "url_changed",
          trustedUrl: "https://api.x.ai/v1",
          pendingUrl: "http://169.254.169.254/latest",
          problem: "not_https",
        },
      ],
    ]);
  });
});

describe("confirming a changed address through the route", () => {
  // #554-T06
  it("trusts the address the admin saw and logs who did it", async () => {
    const portal = await start();

    const response = await call(
      portal,
      "POST",
      "/catalog-providers/url/confirm",
      { providerId: "deepseek", pendingUrl: MOVED },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      provider: {
        id: "deepseek",
        url: { state: "trusted", trustedUrl: MOVED },
      },
    });
    expect(portal.modelsDevLog).toEqual([
      expect.stringMatching(
        /^models\.dev: PROVIDER_URL_CONFIRMED by=\S+ provider="deepseek" /,
      ),
    ]);
  });

  // #554-T06
  it.each([
    [
      "an address that is not the one waiting",
      { providerId: "deepseek", pendingUrl: "https://elsewhere.example/v1" },
      409,
      "url_changed_again",
    ],
    [
      "a refused address",
      { providerId: "xai", pendingUrl: "http://169.254.169.254/latest" },
      409,
      "url_refused",
    ],
    [
      "a provider nobody has",
      { providerId: "nobody", pendingUrl: MOVED },
      404,
      "provider_unknown",
    ],
    [
      "a body that is not the documented one",
      { providerId: "deepseek" },
      422,
      "request_invalid",
    ],
  ])(
    "answers %s with a stable code and writes nothing",
    async (_, body, status, code) => {
      const portal = await start();

      const response = await call(
        portal,
        "POST",
        "/catalog-providers/url/confirm",
        body,
      );

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
      expect(portal.modelsDevLog).toEqual([]);
      expect(
        (await createModelsDevRepository(portal.db).getProvider("deepseek"))
          ?.url.state,
      ).toBe("url_changed");
    },
  );
});

describe("fetching now through the route", () => {
  // #554-T08
  it("fetches with a deadline below the function limit of the route and answers the summary", async () => {
    const portal = await start();
    portal.modelsDevFetch.outcome = {
      status: "applied",
      summary: { models: 13, newModels: 2 },
    };

    const response = await call(portal, "POST", "/catalog-fetch", {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      outcome: "applied",
      summary: { models: 13, newModels: 2 },
    });
    expect(portal.modelsDevFetch.calls).toEqual([
      { deadlineMs: FETCH_NOW_DEADLINE_MS },
    ]);
    // The route runs 60 seconds on the hosted deployment (vercel.json): the run ends first and writes nothing.
    const config = JSON.parse(
      readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"),
    ) as { functions: Record<string, { maxDuration: number }> };
    const limit =
      config.functions["src/app/api/instance-portal/catalog-fetch/route.ts"]
        ?.maxDuration;
    expect(limit).toBe(60);
    expect(FETCH_NOW_DEADLINE_MS).toBeLessThan((limit ?? 0) * 1000);
  });

  // #554-T08
  it("passes the reasons the admin accepted on", async () => {
    const portal = await start();
    portal.modelsDevFetch.outcome = { status: "applied", summary: {} };

    await call(portal, "POST", "/catalog-fetch", {
      acceptReasons: ["models_dev_guard_growth"],
    });

    expect(portal.modelsDevFetch.calls).toEqual([
      { deadlineMs: FETCH_NOW_DEADLINE_MS, acceptReasons: ["growth"] },
    ]);
    expect(portal.modelsDevLog).toEqual([
      expect.stringMatching(
        /^models\.dev: FETCH_NOW by=\S+ accept_reasons=models_dev_guard_growth outcome=applied$/,
      ),
    ]);
  });

  // #554-T08
  it("answers a guard stop with every reason that tripped and the figures", async () => {
    const portal = await start();
    portal.modelsDevFetch.outcome = {
      status: "failed",
      code: "models_dev_guard_unlisted_share",
      guard: {
        reasons: ["unlisted_share", "growth"],
        figures: {
          unlisted: 3,
          listed: 13,
          listedAfter: 20,
          providersUnlisted: 0,
          providersListed: 6,
          enabledUnlisted: 0,
          enabledListed: 0,
          newlyBlocked: 0,
          providers: 6,
          oversizedProviders: 0,
        },
      },
    };

    const response = await call(portal, "POST", "/catalog-fetch", {});

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "models_dev_guard_unlisted_share",
      reasons: ["models_dev_guard_unlisted_share", "models_dev_guard_growth"],
      details: {
        unlisted: 3,
        listed: 13,
        listedAfter: 20,
        providersUnlisted: 0,
        providersListed: 6,
        enabledUnlisted: 0,
        enabledListed: 0,
        newlyBlocked: 0,
        providers: 6,
        oversizedProviders: 0,
      },
    });
  });

  // #554-T08
  it.each([
    ["models_dev_guard_growth", 409],
    ["models_dev_guard_unlisted_share", 409],
    ["models_dev_guard_url_changed_share", 409],
    ["models_dev_guard_provider_size", 409],
    ["models_dev_timeout", 504],
    ["models_dev_unreachable", 502],
    ["models_dev_internal", 500],
  ] as const)(
    "answers a fetch that ended with %s with a stable code and status %s",
    async (code, status) => {
      const portal = await start();
      portal.modelsDevFetch.outcome = { status: "failed", code };

      const response = await call(portal, "POST", "/catalog-fetch", {});

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    },
  );

  // #554-T08
  it("says that a fetch is running, and that the fetch is off", async () => {
    const portal = await start();

    portal.modelsDevFetch.outcome = {
      status: "skipped",
      reason: "already_running",
    };
    const running = await call(portal, "POST", "/catalog-fetch", {});
    portal.modelsDevFetch.outcome = { status: "skipped", reason: "fetch_off" };
    const off = await call(portal, "POST", "/catalog-fetch", {});

    expect(running.status).toBe(409);
    expect(await running.json()).toEqual({ error: "fetch_in_progress" });
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "fetch_off" });
  });

  // #554-T08
  it("limits the route and says when to try again", async () => {
    const portal = await start();
    portal.modelsDevFetch.outcome = { status: "applied", summary: {} };
    for (let i = 0; i < FETCH_NOW_MAX; i += 1)
      expect((await call(portal, "POST", "/catalog-fetch", {})).status).toBe(
        200,
      );

    const response = await call(portal, "POST", "/catalog-fetch", {});

    expect(response.status).toBe(429);
    const body = (await response.json()) as {
      error: string;
      retryAfterSeconds: number;
    };
    expect(body.error).toBe("fetch_rate_limited");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(portal.modelsDevFetch.calls).toHaveLength(FETCH_NOW_MAX);
  });

  // #554-T08
  it("refuses a body that is not the documented one before it fetches", async () => {
    const portal = await start();

    const response = await call(portal, "POST", "/catalog-fetch", {
      acceptReasons: "yes",
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "request_invalid" });
    expect(portal.modelsDevFetch.calls).toEqual([]);
  });
});

describe("the codes", () => {
  // #554-T04
  it("have a status each", () => {
    for (const code of MODELS_DEV_ADMIN_ERROR_CODES)
      expect(MODELS_DEV_ADMIN_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });
});
