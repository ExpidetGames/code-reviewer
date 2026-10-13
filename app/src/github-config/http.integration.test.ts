// SPDX-License-Identifier: Apache-2.0

// The GitHub data routes of the admin portal with real requests through the real proxy, the real handlers,
// a real database, the real Better Auth and the fake GitHub: who may call them, what a request must look like,
// the manifest flow from the first click to the stored App, that every address in the manifest comes from the
// configured public URL and not from a header, and that no answer carries a secret.
import { describe, expect, it } from "vitest";
import {
  ADMIN_TEST_BASE_URL,
  ADMIN_TEST_CREDENTIALS,
  createAdminHarness,
  MISSING_ANSWER_MARKER,
} from "../test-support/admin-harness.ts";
import {
  TEST_APP_ID,
  TEST_APP_SLUG,
  testAppKeys,
} from "../test-support/github-app.ts";
import {
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
} from "../test-support/github-fake.ts";

type Portal = Awaited<ReturnType<typeof createAdminHarness>>;

async function start() {
  const portal = await createAdminHarness();
  await portal.createUser({
    id: "member-1",
    email: "member@example.com",
    password: "a-member-password-0123",
    emailVerified: true,
  });
  const memberCookies = await portal.signIn(
    "member@example.com",
    "a-member-password-0123",
  );
  return { portal, memberCookies };
}

const ROUTES: Array<[string, string]> = [
  ["GET", "/api/admin/github"],
  ["PUT", "/api/admin/github"],
  ["POST", "/api/admin/github/manifest"],
  ["GET", "/api/admin/github/manifest/callback?code=x&state=y"],
  ["POST", "/api/admin/github/check"],
];

describe("who reaches the GitHub routes", () => {
  // #102-GH-08
  it.each(ROUTES)(
    "answers a person who is not an admin like a path that does not exist: %s %s",
    async (method, path) => {
      const { portal, memberCookies } = await start();

      const response = await portal.visit(path, {
        method,
        cookies: memberCookies,
        ...(method === "GET" ? {} : { body: {} }),
      });

      expect(response.status).toBe(404);
      expect(response.headers.get(MISSING_ANSWER_MARKER)).toBe("1");
    },
  );

  // #102-GH-08
  it.each(ROUTES)(
    "answers a visitor without a session with 401: %s %s",
    async (method, path) => {
      const { portal } = await start();

      const response = await portal.visit(path, {
        method,
        ...(method === "GET" ? {} : { body: {} }),
      });

      expect(response.status).toBe(401);
    },
  );
});

describe("what a change must look like", () => {
  it("refuses a request from another site", async () => {
    const { portal } = await start();

    const response = await portal.visit("/api/admin/github", {
      method: "PUT",
      cookies: portal.adminCookies,
      headers: { "sec-fetch-site": "cross-site" },
      body: { privateApp: true },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross_site_request" });
  });

  it("refuses a body that is not JSON, one that names nothing or two settings, and a bad value", async () => {
    const { portal } = await start();
    const put = (body: unknown, headers: Record<string, string> = {}) =>
      portal.visit("/api/admin/github", {
        method: "PUT",
        cookies: portal.adminCookies,
        headers,
        body,
      });

    expect((await put("x=1", { "content-type": "text/plain" })).status).toBe(
      415,
    );
    expect((await put({})).status).toBe(422);
    expect((await put({ privateApp: true, app: {} })).status).toBe(422);
    const invalid = await put({ app: { appId: "x" } });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      error: "invalid_input",
      issues: expect.arrayContaining([
        { field: "appId", code: "app_id_invalid" },
      ]),
    });
  });

  it("answers with Cache-Control: no-store", async () => {
    const { portal } = await start();

    const response = await portal.visit("/api/admin/github", {
      cookies: portal.adminCookies,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the manual form through the route", () => {
  // #102-GH-05
  it("saves the values, answers the view and never a secret, and the sign-in methods follow", async () => {
    const { portal } = await start();
    const fake = await portal.fakeGithub();
    expect(fake.baseUrl).toContain("http://");

    const response = await portal.visit("/api/admin/github", {
      method: "PUT",
      cookies: portal.adminCookies,
      body: {
        app: {
          appId: TEST_APP_ID,
          slug: TEST_APP_SLUG,
          privateKey: testAppKeys().privateKey,
          webhookSecret: "a-webhook-secret-of-the-test",
          clientId: TEST_CLIENT_ID,
          clientSecret: TEST_CLIENT_SECRET,
          privateApp: true,
        },
      },
    });

    const text = await response.text();
    expect(response.status).toBe(200);
    for (const secret of [
      testAppKeys().privateKey,
      "a-webhook-secret-of-the-test",
      TEST_CLIENT_SECRET,
    ])
      expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      github: {
        status: "configured",
        app: { appId: TEST_APP_ID, slug: TEST_APP_SLUG },
        secrets: {
          privateKey: "configured",
          webhookSecret: "configured",
          clientSecret: "configured",
        },
      },
    });
    // GitHub sign-in is now available to the settings, which read the stored user authorization.
    const settings = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });
    expect(
      ((await settings.json()) as { githubConfigured: boolean })
        .githubConfigured,
    ).toBe(true);
  });
});

describe("the manifest flow through the routes", () => {
  async function startFlow(
    portal: Portal,
    body: unknown = {},
    cookies = portal.adminCookies,
  ) {
    const response = await portal.visit("/api/admin/github/manifest", {
      method: "POST",
      cookies,
      body,
    });
    return response;
  }

  // #102-GH-19
  it("creates the App from the first click to the stored credentials, and lands on the GitHub App page", async () => {
    const { portal } = await start();
    const started = await startFlow(portal);
    const { postUrl, manifest } = (await started.json()) as {
      postUrl: string;
      manifest: string;
    };
    const fake = await portal.fakeGithub();

    const back = await fake.confirmManifest(postUrl, manifest);
    const callback = await portal.visit(
      `/api/admin/github/manifest/callback?${back.searchParams.toString()}`,
      { cookies: portal.adminCookies },
    );

    expect(started.status).toBe(200);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      "/admin/integrations/github?github=created",
    );
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    const view = await portal.visit("/api/admin/github", {
      cookies: portal.adminCookies,
    });
    expect(await view.json()).toMatchObject({
      status: "configured",
      app: { origin: "manifest" },
    });
  });

  // #102-GH-17
  it("builds every address of the manifest from the configured public URL, whatever the Host header says", async () => {
    const { portal } = await start();

    const started = await startFlow(portal);
    const forged = await portal.visit("/api/admin/github/manifest", {
      method: "POST",
      cookies: portal.adminCookies,
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
        origin: "https://evil.example",
        forwarded: "host=evil.example",
      },
      body: {},
    });

    for (const response of [started, forged]) {
      const { manifest, postUrl } = (await response.json()) as {
        manifest: string;
        postUrl: string;
      };
      expect(manifest).not.toContain("evil.example");
      const parsed = JSON.parse(manifest) as {
        url: string;
        redirect_url: string;
        hook_attributes: { url: string };
        callback_urls: string[];
        setup_url: string;
      };
      expect(parsed.url).toBe(ADMIN_TEST_BASE_URL);
      expect(parsed.redirect_url.startsWith(ADMIN_TEST_BASE_URL)).toBe(true);
      expect(parsed.hook_attributes.url.startsWith(ADMIN_TEST_BASE_URL)).toBe(
        true,
      );
      expect(
        parsed.callback_urls.every((u) => u.startsWith(ADMIN_TEST_BASE_URL)),
      ).toBe(true);
      expect(parsed.setup_url.startsWith(ADMIN_TEST_BASE_URL)).toBe(true);
      expect(postUrl).not.toContain("evil.example");
    }
  });

  // #102-GH-02
  it("stores nothing when the callback comes from another session of the same admin, and tells the page so", async () => {
    const { portal } = await start();
    const started = await startFlow(portal);
    const { postUrl, manifest } = (await started.json()) as {
      postUrl: string;
      manifest: string;
    };
    const fake = await portal.fakeGithub();
    const back = await fake.confirmManifest(postUrl, manifest);
    // The same admin, signed in again: another session.
    const otherSession = await portal.signIn(
      ADMIN_TEST_CREDENTIALS.email,
      ADMIN_TEST_CREDENTIALS.password,
    );

    const callback = await portal.visit(
      `/api/admin/github/manifest/callback?${back.searchParams.toString()}`,
      { cookies: otherSession },
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      "/admin/integrations/github?github_error=state_invalid",
    );
    expect(fake.conversionCodes()).toEqual([]);
    expect((await portal.credentials.load()).source).toBe("none");
  });

  it("refuses to start again over an App that is configured unless asked to replace it", async () => {
    const { portal } = await start();
    const first = await startFlow(portal);
    const { postUrl, manifest } = (await first.json()) as {
      postUrl: string;
      manifest: string;
    };
    const fake = await portal.fakeGithub();
    const back = await fake.confirmManifest(postUrl, manifest);
    await portal.visit(
      `/api/admin/github/manifest/callback?${back.searchParams.toString()}`,
      { cookies: portal.adminCookies },
    );

    const again = await startFlow(portal);
    const replace = await startFlow(portal, { replace: true });

    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_configured" });
    expect(replace.status).toBe(200);
  });

  // #102-GH-02
  it("limits how often the flow can be started and says when to try again", async () => {
    const { portal } = await start();

    const answers = [];
    for (let i = 0; i < 12; i += 1) answers.push(await startFlow(portal));

    const last = answers.at(-1);
    expect(answers.filter((r) => r.status === 200)).toHaveLength(10);
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("the check of the permissions through the route", () => {
  it("lists what an App made by hand lacks", async () => {
    const { portal } = await start();
    const fake = await portal.fakeGithub();
    fake.setAppAccountPermissions({});
    await portal.visit("/api/admin/github", {
      method: "PUT",
      cookies: portal.adminCookies,
      body: {
        app: {
          appId: TEST_APP_ID,
          slug: TEST_APP_SLUG,
          privateKey: testAppKeys().privateKey,
          webhookSecret: "a-webhook-secret-of-the-test",
          clientId: "",
          clientSecret: "",
          privateApp: false,
        },
      },
    });

    const response = await portal.visit("/api/admin/github/check", {
      method: "POST",
      cookies: portal.adminCookies,
      body: {},
    });

    expect(await response.json()).toEqual({
      ok: true,
      missing: ["emails", "members"],
    });
  });

  // #102-GH-08
  it.each(["/api/admin/github/check"])(
    "only takes a JSON object: %s refuses form data and plain text with 415 and does nothing",
    async (path) => {
      const { portal } = await start();

      for (const type of ["application/x-www-form-urlencoded", "text/plain"]) {
        const response = await portal.visit(path, {
          method: "POST",
          cookies: portal.adminCookies,
          headers: { "content-type": type },
          body: "a=b",
        });

        expect(response.status).toBe(415);
        expect(await response.json()).toEqual({
          error: "unsupported_content_type",
        });
      }
    },
  );

  it("says that there is nothing to ask before an App is configured", async () => {
    const { portal } = await start();

    const response = await portal.visit("/api/admin/github/check", {
      method: "POST",
      cookies: portal.adminCookies,
      body: {},
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });
});
