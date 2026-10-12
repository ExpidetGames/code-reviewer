// SPDX-License-Identifier: Apache-2.0

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
// The gates the pages ask (a verified address, a workspace): a test changes them with `startApp(harness, gates)`.
const pageGates = vi.hoisted(() => ({
  current: null as unknown,
}));
vi.mock("../auth/access-gates-runtime.ts", () => ({
  getAccessGates: () => pageGates.current,
}));

import { signOut } from "../auth/actions.ts";
import ProjectsPage from "../app/(app)/projects/page.tsx";
import RunsPage from "../app/(app)/runs/page.tsx";
import RunDetailPage from "../app/(app)/runs/[id]/page.tsx";
import SettingsPage from "../app/(app)/settings/page.tsx";
import ProjectSettingsPage from "../app/(app)/projects/[repositoryId]/page.tsx";
import type { AccessGates } from "../auth/access-gates.ts";
import { noWorkspaceGates, openGates } from "../test-support/open-gates.ts";

const APP_PAGES = [
  { path: "/projects", render: ProjectsPage },
  {
    path: "/runs",
    render: () =>
      RunsPage({ searchParams: Promise.resolve({}) } as Parameters<
        typeof RunsPage
      >[0]),
  },
  {
    path: "/runs/some-run",
    render: () =>
      RunDetailPage({
        params: Promise.resolve({ id: "some-run" }),
      } as Parameters<typeof RunDetailPage>[0]),
  },
  { path: "/settings", render: SettingsPage },
  {
    path: "/projects/some-repository",
    render: () =>
      ProjectSettingsPage({
        params: Promise.resolve({ repositoryId: "some-repository" }),
      } as Parameters<typeof ProjectSettingsPage>[0]),
  },
] as const;

async function startApp(
  existing?: AuthHarness,
  gates: AccessGates = openGates,
) {
  const harness = existing ?? (await createAuthHarness());
  request.harness = harness;
  pageGates.current = gates;
  const proxy = createAccessProxy({
    getAuth: () => harness.auth,
    getGates: () => gates,
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
  pageGates.current = null;
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

describe("a signed in person who belongs to no workspace", () => {
  // CR-34-T12
  it.each(APP_PAGES)(
    "is sent to the page that says so from $path, by the proxy and by the page itself",
    async ({ path, render }) => {
      const signedIn = await startApp();
      const { cookies } = await signedIn.signIn();
      const app = await startApp(signedIn, noWorkspaceGates);

      const response = await app.visit(path, cookies);
      app.sendCookies(cookies);
      const digest = await redirectTarget(render);

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `${TEST_BASE_URL}/no-access`,
      );
      expect(digest).toMatch(/^NEXT_REDIRECT;[a-z]+;\/no-access;/);
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
