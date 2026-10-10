// Pins down who gets in: the access proxy in front of every route, driven with real requests
// against a real Better Auth instance and a real SQLite file. Without a valid session a page sends
// the person to the login page and a data route answers 401; a signed out, expired or forged
// session counts as no session. The route list is read from the file system, so a route added
// without deciding here whether it is public makes the test fail (default deny).
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type CookieJar,
} from "../test-support/auth-harness.ts";
import { createAccessProxy } from "./access-proxy.ts";

const APP_DIRECTORY = join(import.meta.dirname, "..", "app");

// Every route of the app and whether it needs a session. A new route must be added here.
const PUBLIC_ROUTES = ["/login", "/api/health", "/api/auth/[...all]"] as const;
const PROTECTED_ROUTES = ["/"] as const;

// Routes as the file system defines them: every page.tsx and route.ts below src/app.
function discoverRoutes(): string[] {
  const routes: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^(page|route)\.(ts|tsx)$/.test(entry.name)) {
        const segments = relative(APP_DIRECTORY, directory)
          .split(sep)
          .filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment));
        routes.push(`/${segments.join("/")}`);
      }
    }
  };
  walk(APP_DIRECTORY);
  return routes.sort();
}

/** A concrete URL path for a route pattern such as `/api/auth/[...all]` or `/p/[id]`. */
function concretePath(route: string): string {
  return route.replace(/\[\.\.\.[^\]]+\]/g, "x/y").replace(/\[[^\]]+\]/g, "x");
}

async function createGuardedApp() {
  const harness = await createAuthHarness();
  const proxy = createAccessProxy({
    getAuth: () => harness.auth,
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
    const known = [...PUBLIC_ROUTES, ...PROTECTED_ROUTES].sort();

    expect(discoverRoutes()).toEqual(known);
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
      policy: (user) => user.githubLogin !== "octocat",
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
