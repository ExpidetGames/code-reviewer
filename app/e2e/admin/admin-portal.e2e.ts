// SPDX-License-Identifier: Apache-2.0

// The admin portal in a real browser against a production build: the instance admin signs in with email
// and password and finds the sections and the checklist; a person signed in with GitHub who is not
// an admin gets the 404 of a page that does not exist (the same one, nothing says the portal is there),
// also from the data route; a visitor without a session is sent to the login. The admin changes a setting
// and sees who changed it. The rules behind are proven as integration tests (src/admin/).
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import { rawRequest } from "../helpers/raw-request";
import {
  addGithubAccount,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";

const member: GithubAccount = {
  id: 7300101,
  login: "portal-journey",
  name: "Portal Journey",
  email: "portal-journey@example.test",
};

const MISSING = "/there-is-no-such-page";

// The files of the portal by their own address (src/admin/paths.ts): nobody asks for them, so they
// have to answer as a path that is not there, including spellings the router reads the same way.
const INTERNAL_PATHS = [
  "/instance-portal",
  "/instance-portal/setup",
  "/instance-portal/mail",
  "/%69nstance-portal",
  "/instance-portal/./setup",
  "/api/instance-portal/settings",
];

// Everything an observer sees of an answer (status, every header with its name exactly as written,
// the body), apart from what differs for every request.
function observe(
  page: Page,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    data?: unknown;
  } = {},
) {
  const body =
    init.data === undefined
      ? undefined
      : typeof init.data === "string"
        ? init.data
        : JSON.stringify(init.data);
  return rawRequest(page, e2eEnv.appUrl, path, {
    ...(init.method === undefined ? {} : { method: init.method }),
    headers: {
      ...(body !== undefined && typeof init.data !== "string"
        ? { "content-type": "application/json" }
        : {}),
      ...init.headers,
    },
    ...(body === undefined ? {} : { body }),
  });
}

/**
 * Asks for each path the way a browser, a client navigation, a prefetch, a script and a write do, and
 * expects the answer of `MISSING` to the same request: the status, the headers (their names as written
 * and their values, `Cache-Control` included), the body, and nothing that says a proxy or a rewrite
 * was involved.
 */
async function expectTheAnswerOfAMissingPath(
  page: Page,
  paths: string[],
): Promise<void> {
  const reads: Array<[string, string, Record<string, string>]> = [
    ["a page request", "GET", {}],
    ["an RSC request (client navigation)", "GET", { RSC: "1" }],
    ["an RSC prefetch", "GET", { RSC: "1", "Next-Router-Prefetch": "1" }],
    ["a request for JSON", "GET", { Accept: "application/json" }],
    ["a HEAD request", "HEAD", {}],
    ["an OPTIONS request", "OPTIONS", {}],
  ];
  for (const [label, method, headers] of reads) {
    const expected = await observe(page, MISSING, { method, headers });
    expect(expected.status, label).toBe(404);
    for (const path of paths) {
      const answer = await observe(page, path, { method, headers });
      expect(answer.status, `${label} ${path}`).toBe(expected.status);
      expect(answer.lines, `${label} ${path}`).toEqual(expected.lines);
      expect(answer.body, `${label} ${path}`).toBe(expected.body);
      // The answer of a rewrite made by the proxy would carry this. (`x-nextjs-rewritten-path` is on an
      // RSC answer of every missing path, see next.config.ts, so the comparison above covers it.)
      expect(answer.headers["x-middleware-rewrite"]).toBeUndefined();
      // Depends on who asks, so no shared cache may keep it.
      expect(answer.headers["cache-control"]).toContain("no-store");
    }
  }

  // Writes, and a Server Function posted to the path, get what a missing path gives them.
  const writes: Array<{
    method: string;
    headers?: Record<string, string>;
    data: unknown;
  }> = [
    { method: "PUT", data: { tenancy: "multi" } },
    { method: "POST", data: {} },
    { method: "DELETE", data: "" },
    {
      method: "POST",
      headers: { "Next-Action": "00abc", "Content-Type": "text/plain" },
      data: "[]",
    },
  ];
  for (const init of writes) {
    const expected = await observe(page, MISSING, init);
    for (const path of paths) {
      const answer = await observe(page, path, init);
      expect(answer, `${init.method} ${path}`).toEqual(expected);
    }
  }
}

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
  await page.getByLabel("Password").fill(e2eEnv.adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/default\/projects$/);
}

test.describe("the admin portal", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, member);
  });

  // #98-AD-03
  test("@smoke the instance admin opens the portal and sees the sections and the checklist", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    await page.getByRole("button", { name: "admin", exact: true }).click();
    await page.getByRole("menuitem", { name: "Admin" }).click();

    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Admin" }),
    ).toBeVisible();
    // The address stays /admin; the files behind it are not an address of their own.
    expect((await page.request.get("/instance-portal")).status()).toBe(404);
    const sections = page.getByRole("navigation", { name: "Admin" });
    await expect(sections.getByRole("link")).toHaveText([
      "Overview",
      "Approvals",
      "Setup",
      "Limits",
      "Integrations",
      "Mail",
    ]);
    await expect(
      sections.getByRole("link", { name: "Overview" }),
    ).toHaveAttribute("aria-current", "page");
    const checklist = page.getByRole("region", { name: "Checklist" });
    await expect(checklist.getByText("Mail server")).toBeVisible();
    await expect(checklist.getByText("GitHub", { exact: true })).toBeVisible();
    await expect(checklist.getByText("Tenancy")).toBeVisible();
    await expect(checklist.getByText("Sign-up rule")).toBeVisible();
  });

  // #168-T05
  test("@smoke the admin opens the sections from the drawer and it closes after a choice", async ({
    page,
  }) => {
    // A narrow window on the one app of this project: set here, not with `test.use`, so the file
    // keeps its single worker (its `beforeAll` imports the member once).
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAsAdmin(page);
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { level: 1, name: "Admin" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    const nav = page.getByRole("navigation", { name: "Admin" });
    await expect(nav.getByRole("link")).toHaveText([
      "Overview",
      "Approvals",
      "Setup",
      "Limits",
      "Integrations",
      "Mail",
    ]);
    await nav.getByRole("link", { name: "Mail" }).click();

    await expect(
      page.getByRole("heading", { level: 1, name: "Mail" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(
      0,
    );
  });

  // #156
  test("an admin's portal prefetch answer is private and no-store, never a year of shared caching", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    // What the browser asks for ahead of a navigation inside the portal, and what the server answers.
    const prefetches = new Map<string, string>();
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== e2eEnv.appUrl) return;
      if (!url.pathname.startsWith("/admin")) return;
      if (response.request().headers()["next-router-prefetch"] !== "1") return;
      prefetches.set(url.pathname, response.headers()["cache-control"] ?? "");
    });

    // Straight to the portal: driving it through the user-menu link races that link's own prefetch
    // (the navigation can win, so no prefetch for `/admin` is ever recorded). The portal's navigation
    // offers its sections, and the browser prefetches them.
    const portal = await page.goto("/admin");
    expect(portal?.status()).toBe(200);
    const nav = page.getByRole("navigation", { name: "Admin" });
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: "Setup" }).hover();
    await expect.poll(() => prefetches.has("/admin/setup")).toBe(true);

    // A prefetch answer is an admin-only answer: no shared cache may keep it, and never for the year
    // of a prerendered answer.
    for (const [path, cacheControl] of prefetches) {
      expect(cacheControl, path).toContain("private");
      expect(cacheControl, path).toContain("no-store");
      expect(cacheControl, path).not.toContain("s-maxage");
    }
  });

  // #98-AD-14
  test("the admin changes the sign-up rule and the limit and sees who changed them", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    await page.goto("/admin/setup");
    await page.getByRole("radio", { name: /Allowed email domains/ }).check();
    await page.getByLabel("Domains", { exact: true }).fill("e2e.test");
    await page.getByRole("button", { name: "Save sign-up rule" }).click();
    // ("Saved." only shows for an instant: the form starts again from the saved values, so the lasting
    // proof is what the page says once it has the new data.)
    // Nothing can verify addresses yet, so the notice says the rule does not work.
    await expect(page.getByRole("note")).toContainText("does not work yet");
    await expect(
      page
        .getByRole("form", { name: "Who may sign up" })
        .getByText(`Last changed by ${e2eEnv.adminEmail}`),
    ).toBeVisible();

    await page.goto("/admin/limits");
    await page.getByLabel(/Maximum number of workspaces/).fill("4");
    await page.getByRole("button", { name: "Save limit" }).click();
    await expect(
      page.getByText(`Last changed by ${e2eEnv.adminEmail}`),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/Maximum number of workspaces/)).toHaveValue(
      "4",
    );
    await expect(
      page.getByText(`Last changed by ${e2eEnv.adminEmail}`),
    ).toBeVisible();
  });

  // #98-AD-02
  test("a signed in person who is not an admin gets exactly the answer of a page that does not exist, everywhere in the portal", async ({
    page,
  }) => {
    await signInThroughTheForm(page, member);

    await expectTheAnswerOfAMissingPath(page, [
      "/admin",
      "/admin/setup",
      "/admin/mail",
      "/%61dmin",
      "/api/admin/settings",
    ]);

    // A trailing slash is redirected to the path without it, as for any other path.
    const slash = await observe(page, "/admin/", {});
    const slashMissing = await observe(page, `${MISSING}/`, {});
    expect(slash.status).toBe(slashMissing.status);
    expect(slash.headers.location).toBe("/admin");
    expect(slashMissing.headers.location).toBe(MISSING);

    // And in the browser: the 404 page, no portal, no way to it in the menu.
    const visit = await page.goto("/admin");
    expect(visit?.status()).toBe(404);
    await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(
      0,
    );
    await page.goto("/w/default/projects");
    await page.getByRole("button", { name: member.name }).click();
    await expect(page.getByRole("menuitem", { name: "Admin" })).toHaveCount(0);
  });

  // #138
  test("the files of the portal by their own address are a missing path to a person who is not an admin, in every detail", async ({
    page,
  }) => {
    await signInThroughTheForm(page, member);

    await expectTheAnswerOfAMissingPath(page, INTERNAL_PATHS);

    // A trailing slash is redirected to the path without it, as for any other path.
    const slash = await observe(page, "/instance-portal/", {});
    expect(slash.status).toBe((await observe(page, `${MISSING}/`, {})).status);
    expect(slash.headers.location).toBe("/instance-portal");

    // Next.js's own files keep their own answer (the rewrite of missing paths leaves them out).
    const asset = await observe(page, "/_next/static/chunks/no-such-file.js");
    expect(asset.status).toBe(404);
    expect(asset.headers["x-nextjs-rewritten-path"]).toBeUndefined();
  });

  // #138
  test("the header that marks a request as one for a missing path does nothing on the paths the proxy does not see", async ({
    page,
    request,
  }) => {
    await signInThroughTheForm(page, member);
    // Found in the page of the app, so the files exist whatever the build is called.
    const html = await (await request.get("/login")).text();
    const script = /\/_next\/static\/[^"']+\.js/.exec(html)?.[0];
    expect(script).toBeDefined();
    const image = `/_next/image?url=${encodeURIComponent("/favicon.ico")}&w=32&q=75`;

    for (const path of [script ?? "", image, "/favicon.ico"]) {
      const marked = await observe(page, path, {
        headers: { "x-portal-denied": "1" },
      });
      expect((await observe(page, path)).status, path).toBe(200);
      expect(marked.status, path).toBe(200);
    }
    // The marker makes a page that is seen by the proxy a missing one for the requester alone: the proxy
    // takes it off first.
    expect(
      (
        await observe(page, "/w/default/projects", {
          headers: { "x-portal-denied": "1" },
        })
      ).status,
    ).toBe(200);
  });

  // #138
  test("the files of the portal by their own address are a missing path to the instance admin too, in every detail", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    await expectTheAnswerOfAMissingPath(page, INTERNAL_PATHS);

    // The address the admin uses still works.
    const portal = await page.goto("/admin");
    expect(portal?.status()).toBe(200);
  });

  // A client can send any `X-Forwarded-Proto` (a reverse proxy sets `https`, and nothing in front of the
  // app can be told from a client that sends the same). The proxy's rewrite to the files of the portal must
  // not depend on it.
  // #146
  test("the instance admin reaches the portal whatever X-Forwarded-Proto says, as behind a reverse proxy", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    const plain = await observe(page, "/api/admin/settings");
    expect(plain.status).toBe(200);
    const portal = await observe(page, "/admin/setup", {
      headers: { accept: "text/html" },
    });
    expect(portal.status).toBe(200);

    for (const forwarded of [
      "https",
      "http",
      "HTTPS",
      "https, http",
      "javascript",
      "",
      "garbage ://",
    ]) {
      const label = JSON.stringify(forwarded);
      const headers = { "x-forwarded-proto": forwarded };
      const data = await observe(page, "/api/admin/settings", { headers });
      expect(data.status, `data route ${label}`).toBe(200);
      expect(data.body, `data route ${label}`).toBe(plain.body);
      const rendered = await observe(page, "/admin/setup", {
        headers: { ...headers, accept: "text/html" },
      });
      expect(rendered.status, `page ${label}`).toBe(200);
    }
    // What a reverse proxy (Coolify, Traefik) sends with a request.
    const proxied = await observe(page, "/api/admin/settings", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "reviewer.example.com",
        "x-forwarded-port": "443",
      },
    });
    expect(proxied.status).toBe(200);
    expect(proxied.body).toBe(plain.body);
  });

  // #146
  test("a person who is not an admin gets the answer of a missing path whatever X-Forwarded-Proto says", async ({
    page,
  }) => {
    await signInThroughTheForm(page, member);

    for (const forwarded of ["https", "javascript", "", "garbage ://"]) {
      // The header the proxy sets for the admin's request is the proxy's alone; one sent from outside
      // does not serve the portal to anyone.
      const headers = {
        "x-forwarded-proto": forwarded,
        "x-portal-rewrite": "anything",
      };
      for (const path of ["/api/admin/settings", "/admin", "/admin/setup"]) {
        const expected = await observe(page, MISSING, { headers });
        const answer = await observe(page, path, { headers });
        expect(answer.status, `${path} ${JSON.stringify(forwarded)}`).toBe(404);
        expect(answer.lines, `${path} ${JSON.stringify(forwarded)}`).toEqual(
          expected.lines,
        );
        expect(answer.body, `${path} ${JSON.stringify(forwarded)}`).toBe(
          expected.body,
        );
      }
    }
  });

  // #98-AD-17
  test("the page of a reset link asks the browser not to send its address on as a referrer", async ({
    request,
  }) => {
    const page = await request.get("/reset-password?token=abc");

    expect(page.status()).toBe(200);
    expect(await page.text()).toMatch(
      /<meta name="referrer" content="no-referrer"\/?>/,
    );
  });

  // #98-AD-01
  test("a visitor without a session is sent to the login, and the data route says 401", async ({
    page,
  }) => {
    await page.goto("/admin/setup");
    await expect(page).toHaveURL(/\/login$/);

    const data = await page.request.get("/api/admin/settings");
    expect(data.status()).toBe(401);
  });
});
