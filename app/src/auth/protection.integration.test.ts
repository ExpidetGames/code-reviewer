// Pins down who gets in: the access proxy in front of every route, driven with real requests
// against a real Better Auth instance and a real SQLite file. Without a valid session a page sends
// the person to the login page and a data route answers 401; a signed out, expired or forged
// session counts as no session. The route list is read from the file system, so a route added
// without deciding here whether it is public makes the test fail (default deny).
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type CookieJar,
} from "../test-support/auth-harness.ts";
import { concretePath, discoverRoutes } from "../test-support/routes.ts";
import { createAccessProxy } from "./access-proxy.ts";

// Every route of the app and whether it needs a session. A new route must be added here.
const PUBLIC_ROUTES = [
  "/login",
  "/api/health",
  "/api/auth/[...all]",
  // GitHub signs its deliveries; the route checks the signature itself (src/webhooks/README.md).
  "/api/webhooks/github-app",
  // The runner sends its own shared token (src/runner-api/README.md).
  "/api/runners/v1/claim",
  "/api/runners/v1/jobs/[id]/heartbeat",
  "/api/runners/v1/jobs/[id]/complete",
] as const;
const PROTECTED_ROUTES = ["/"] as const;
// Data routes: a visitor without a session gets 401 instead of a redirect.
const PROTECTED_DATA_ROUTES = [
  "/api/repositories/[repositoryId]/project",
  "/api/repositories/[repositoryId]/project/settings",
  "/api/review-settings",
] as const;
// Files the proxy matcher leaves out on purpose (src/proxy.ts), so no session rule applies to them.
const OUTSIDE_THE_PROXY = ["/favicon.ico"] as const;

async function createGuardedApp() {
  const harness = await createAuthHarness();
  const proxy = createAccessProxy({
    getAuth: () => harness.auth,
    getPolicy: () => harness.policy,
  });
  function visit(path: string, cookies?: CookieJar, method = "GET") {
    const headers = new Headers();
    if (cookies && cookies.size > 0)
      headers.set("cookie", cookieHeader(cookies));
    return proxy(
      new NextRequest(`${TEST_BASE_URL}${path}`, { method, headers }),
    );
  }
  return { ...harness, visit };
}

function passesThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a request without a session", () => {
  // CR-18-T07
  it("knows every route of the app as either public or protected", () => {
    const known = [
      ...PUBLIC_ROUTES,
      ...PROTECTED_ROUTES,
      ...PROTECTED_DATA_ROUTES,
      ...OUTSIDE_THE_PROXY,
    ].sort();

    expect(discoverRoutes().map(({ route }) => route)).toEqual(known);
  });

  // CR-18-T07
  it.each(PROTECTED_ROUTES)(
    "is sent to the login page for the page %s",
    async (route) => {
      const app = await createGuardedApp();

      const response = await app.visit(concretePath(route));

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
    },
  );

  // CR-18-T07
  it.each(PROTECTED_DATA_ROUTES)(
    "is answered with 401 for the data route %s",
    async (route) => {
      const app = await createGuardedApp();

      const response = await app.visit(concretePath(route), undefined, "PUT");

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    },
  );

  // CR-18-T07
  it.each(PUBLIC_ROUTES)("may open the public route %s", async (route) => {
    const app = await createGuardedApp();

    const response = await app.visit(concretePath(route), undefined, "POST");

    expect(passesThrough(response)).toBe(true);
  });

  // CR-18-T07
  it("may open the paths of the runner and the webhooks, which carry their own authentication", async () => {
    const app = await createGuardedApp();

    for (const path of ["/api/runners/v1/claim", "/api/webhooks/github-app"]) {
      expect(passesThrough(await app.visit(path, undefined, "POST"))).toBe(
        true,
      );
    }
  });

  // CR-18-T07
  it("is turned away on a route that does not exist yet", async () => {
    const app = await createGuardedApp();

    const page = await app.visit("/projects/42/settings");
    const data = await app.visit("/api/jobs");

    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
    expect(data.status).toBe(401);
    expect(await data.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  // CR-18-T07
  it("is not let in by a path that only looks like a public one", async () => {
    const app = await createGuardedApp();

    for (const path of [
      "/api/healthz",
      "/loginx",
      "/api/runnersx/v1/claim",
      "/api/health/x",
    ]) {
      expect(passesThrough(await app.visit(path)), path).toBe(false);
    }
  });

  it("is turned away when the session cookie is forged", async () => {
    const app = await createGuardedApp();
    await app.signIn();
    const forged = new Map([
      ["better-auth.session_token", "not-a-real-token.forged-signature"],
    ]);

    const response = await app.visit("/", forged);

    expect(response.status).toBe(307);
  });
});

describe("a request with a valid session", () => {
  it("reaches pages and data routes", async () => {
    const app = await createGuardedApp();
    const { cookies } = await app.signIn();

    expect(passesThrough(await app.visit("/", cookies))).toBe(true);
    expect(passesThrough(await app.visit("/api/jobs", cookies))).toBe(true);
  });

  it("is turned away when the access policy refuses the user", async () => {
    const app = await createGuardedApp();
    const { cookies } = await app.signIn();
    const refusing = createAccessProxy({
      getAuth: () => app.auth,
      getPolicy: () => (user) =>
        Promise.resolve(
          user.githubLogin === "octocat"
            ? { allowed: false, reason: "not_allowed" }
            : { allowed: true },
        ),
    });

    const response = await refusing(
      new NextRequest(`${TEST_BASE_URL}/`, {
        headers: { cookie: cookieHeader(cookies) },
      }),
    );

    expect(response.status).toBe(307);
  });
});

describe("a session that has ended", () => {
  // CR-18-T03
  it("stops working when its cookie is sent again after signing out", async () => {
    const app = await createGuardedApp();
    const { cookies } = await app.signIn();
    const oldCookies = new Map(cookies);
    expect(passesThrough(await app.visit("/", oldCookies))).toBe(true);

    const signOut = await app.request("/api/auth/sign-out", {
      method: "POST",
      cookies,
    });
    expect(signOut.status).toBe(200);

    const page = await app.visit("/", oldCookies);
    const data = await app.visit("/api/jobs", oldCookies);
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
    expect(data.status).toBe(401);
    expect(await app.db.selectFrom("sessions").selectAll().execute()).toEqual(
      [],
    );
  });

  // CR-18-T12
  it("is no longer accepted once its 30 days are over, and still is one day before", async () => {
    const app = await createGuardedApp();
    const { cookies } = await app.signIn();
    const day = 24 * 60 * 60 * 1000;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });

    vi.setSystemTime(Date.now() + 29 * day);
    expect(passesThrough(await app.visit("/", cookies))).toBe(true);

    vi.setSystemTime(Date.now() + 1 * day + 1000);
    const page = await app.visit("/", cookies);
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
    expect((await app.visit("/api/jobs", cookies)).status).toBe(401);
  });
});

describe("a check that cannot be made", () => {
  it("refuses the request with 503 instead of letting it through", async () => {
    const proxy = createAccessProxy({
      getAuth: () => {
        throw new Error("the database is not initialized");
      },
      getPolicy: () => () => Promise.resolve({ allowed: true }),
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await proxy(new NextRequest(`${TEST_BASE_URL}/`));

    expect(response.status).toBe(503);
    expect(passesThrough(response)).toBe(false);
    expect(error).toHaveBeenCalled();
  });
});
