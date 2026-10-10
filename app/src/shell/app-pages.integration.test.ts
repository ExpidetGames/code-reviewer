// Pins down who sees the pages inside the app frame (Projects, Runs, Settings): a visitor without a
// session is sent to the login page and gets neither navigation nor user data, from the proxy and
// again from the page itself (the second guard), and the "Sign out" action ends the session on the
// server so the next request to an app page is turned away. Real Better Auth and SQLite; only the
// Next.js request context (headers, cookies) is stood in for, and the process-wide auth singletons
// are pointed at the test instance.
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type AuthHarness,
  type CookieJar,
} from "../test-support/auth-harness.ts";
import { createAccessProxy } from "../auth/access-proxy.ts";

const request = vi.hoisted(() => ({
  headers: new Headers(),
  harness: null as unknown,
  setCookies: [] as string[],
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(request.headers),
  cookies: () =>
    Promise.resolve({
      set: (name: string) => void request.setCookies.push(name),
      get: () => undefined,
      delete: () => undefined,
    }),
}));
vi.mock("../auth/auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/auth.ts")>()),
  getAuth: () => (request.harness as AuthHarness).auth,
}));
vi.mock("../auth/access-runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/access-runtime.ts")>()),
  getAccessPolicy: () => (request.harness as AuthHarness).policy,
}));

import { signOut } from "../auth/actions.ts";
import ProjectsPage from "../app/(app)/projects/page.tsx";
import RunsPage from "../app/(app)/runs/page.tsx";
import SettingsPage from "../app/(app)/settings/page.tsx";

const APP_PAGES = [
  { path: "/projects", render: ProjectsPage },
  { path: "/runs", render: RunsPage },
  { path: "/settings", render: SettingsPage },
] as const;

async function startApp() {
  const harness = await createAuthHarness();
  request.harness = harness;
  const proxy = createAccessProxy({
    getAuth: () => harness.auth,
    getPolicy: () => harness.policy,
  });
  function visit(path: string, cookies?: CookieJar) {
    const headers = new Headers();
    if (cookies && cookies.size > 0)
      headers.set("cookie", cookieHeader(cookies));
    return proxy(new NextRequest(`${TEST_BASE_URL}${path}`, { headers }));
  }
  function sendCookies(cookies: CookieJar) {
    request.headers = new Headers({ cookie: cookieHeader(cookies) });
  }
  return { ...harness, visit, sendCookies };
}

afterEach(() => {
  request.headers = new Headers();
  request.harness = null;
  request.setCookies = [];
});

async function redirectTarget(render: () => Promise<unknown>) {
  const error = await render().then(
    () => null,
    (thrown: unknown) => thrown,
  );
  return (error as { digest?: string } | null)?.digest ?? null;
}

describe("a visitor without a session", () => {
  // CR-36-T04
  it.each(APP_PAGES)(
    "is sent to the login page from $path and receives no navigation or user data",
    async ({ path }) => {
      const app = await startApp();

      const response = await app.visit(path);
      const body = await response.text();

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
      expect(body).toBe("");
      expect([...response.headers.keys()].join(",")).not.toMatch(/user/i);
    },
  );

  // CR-36-T04
  it.each(APP_PAGES)(
    "is sent to the login page by the page $path itself, before it renders anything",
    async ({ render }) => {
      await startApp();

      const digest = await redirectTarget(render);

      expect(digest).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login;/);
    },
  );
});

describe("signing out", () => {
  // CR-36-T03
  it("ends the session on the server so every app page turns the old cookie away", async () => {
    const app = await startApp();
    const { cookies } = await app.signIn();
    const oldCookies = new Map(cookies);
    for (const { path, render } of APP_PAGES) {
      expect((await app.visit(path, oldCookies)).headers.get("location")).toBe(
        null,
      );
      app.sendCookies(oldCookies);
      await expect(render()).resolves.toBeDefined();
    }
    app.sendCookies(cookies);

    const digest = await redirectTarget(signOut);

    expect(digest).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login;/);
    expect(await app.db.selectFrom("sessions").selectAll().execute()).toEqual(
      [],
    );
    for (const { path, render } of APP_PAGES) {
      const response = await app.visit(path, oldCookies);
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`${TEST_BASE_URL}/login`);
      app.sendCookies(oldCookies);
      expect(await redirectTarget(render)).toMatch(
        /^NEXT_REDIRECT;[a-z]+;\/login;/,
      );
    }
  });
});
