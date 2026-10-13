// SPDX-License-Identifier: Apache-2.0

// Pins down who reaches the admin portal, with real requests through the real proxy and the real data
// route over a real database and the real Better Auth: a visitor without a session is sent to the
// sign-in (a page) or gets 401 (a data route); a signed in person who is not an instance admin gets
// the 404 of a path that does not exist, on every page and every data route below the portal, with any
// method, in any spelling, and also from the data route itself when the proxy is not in front; the admin
// gets in, with an unverified email address too. The routes are read from the file system, so a page or
// route added to the portal without a decision here fails the test.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MISSING_ANSWER_MARKER,
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import { concretePath, discoverRoutes } from "../test-support/routes.ts";
import { isInternalPortalPath } from "./paths.ts";

const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// The files of the portal live below /instance-portal; the address of a person is /admin
// (src/admin/paths.ts). `route` is the address a person uses.
const portalFiles = discoverRoutes().filter(({ route }) =>
  isInternalPortalPath(concretePath(route)),
);
const adminRoutes = portalFiles.map(({ route, file }) => ({
  route: route.replace(/^(\/api)?\/instance-portal/, "$1/admin"),
  file,
}));
const pageRoutes = adminRoutes.filter(({ file }) => /page\.[a-z]+$/.test(file));
const dataRoutes = adminRoutes.filter(({ file }) =>
  /route\.[a-z]+$/.test(file),
);

async function startPortal() {
  const portal = await createAdminHarness();
  await portal.createUser({ id: "member-1", ...MEMBER });
  const memberCookies = await portal.signIn(MEMBER.email, MEMBER.password);
  return { portal, memberCookies };
}

// The answer of a path that is no route of the app (the harness's stand-in for Next.js's 404): nothing
// of the portal reached, no redirect, no rewrite header.
function isHidden(response: Response): boolean {
  return (
    response.status === 404 &&
    response.headers.get(MISSING_ANSWER_MARKER) === "1" &&
    response.headers.get("x-middleware-rewrite") === null &&
    response.headers.get("location") === null
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the routes of the portal", () => {
  it("are found on the file system: the pages of the sections, the settings route, the test mail route and the routes of the GitHub integration and the synchronization", () => {
    expect(adminRoutes.map(({ route }) => route).sort()).toEqual([
      "/admin",
      "/admin/approvals",
      "/admin/integrations",
      "/admin/limits",
      "/admin/mail",
      "/admin/setup",
      "/admin/setup/instance",
      "/admin/setup/sign-in",
      "/admin/setup/sign-up",
      "/api/admin/approvals/[id]",
      "/api/admin/github",
      "/api/admin/github/check",
      "/api/admin/github/link",
      "/api/admin/github/manifest",
      "/api/admin/github/manifest/callback",
      "/api/admin/integrations/sync",
      "/api/admin/mail/test",
      "/api/admin/settings",
    ]);
  });
});

describe("the files of the portal", () => {
  it.each(portalFiles.map(({ route }) => route))(
    "are not reachable by their own address %s, not even for the admin",
    async (route) => {
      const { portal, memberCookies } = await startPortal();

      const asAdmin = await portal.visit(route, {
        cookies: portal.adminCookies,
      });
      const asMember = await portal.visit(route, { cookies: memberCookies });

      expect(isHidden(asAdmin)).toBe(true);
      expect(isHidden(asMember)).toBe(true);
    },
  );
});

describe("a visitor without a session", () => {
  // #98-AD-01
  it.each(pageRoutes.map(({ route }) => route))(
    "is sent to the sign-in from the page %s",
    async (route) => {
      const { portal } = await startPortal();

      const response = await portal.visit(concretePath(route));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
        "/login",
      );
    },
  );

  // #98-AD-01
  it.each(
    dataRoutes.flatMap(({ route }) =>
      METHODS.map((method) => ({ route, method })),
    ),
  )(
    "gets 401 from the data route $route with $method",
    async ({ route, method }) => {
      const { portal } = await startPortal();

      const response = await portal.visit(concretePath(route), { method });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    },
  );

  // #98-AD-01
  it("gets 401 from the data route itself when the proxy is not in front, and nothing is changed", async () => {
    const { portal } = await startPortal();

    const get = await portal.callRoute("/api/instance-portal/settings");
    const put = await portal.callRoute("/api/instance-portal/settings", {
      method: "PUT",
      body: { tenancy: "multi" },
    });

    expect([get.status, put.status]).toEqual([401, 401]);
    expect((await portal.service.readSettings()).tenancy.value).toBe("single");
  });
});

describe("a signed in person who is not an instance admin", () => {
  // #98-AD-02
  it.each(
    adminRoutes.flatMap(({ route }) =>
      METHODS.map((method) => ({ route, method })),
    ),
  )(
    "gets the 404 of a missing path from $route with $method",
    async ({ route, method }) => {
      const { portal, memberCookies } = await startPortal();

      const response = await portal.visit(concretePath(route), {
        method,
        cookies: memberCookies,
        ...(method === "GET" ? {} : { body: { tenancy: "multi" } }),
      });

      expect(isHidden(response)).toBe(true);
      expect(await response.text()).not.toContain("reached");
      expect((await portal.service.readSettings()).tenancy.value).toBe(
        "single",
      );
    },
  );

  // #98-AD-02
  it("is handled by the proxy exactly like a person asking for a path that does not exist", async () => {
    const { portal, memberCookies } = await startPortal();

    const portalPaths = ["/admin", "/admin/setup", "/api/admin/settings"];
    const proxied = async (path: string, method = "GET") => {
      const response = await portal.askProxy(path, {
        cookies: memberCookies,
        method,
      });
      return [...response.headers].sort();
    };
    for (const method of ["GET", "POST", "PUT"])
      for (const path of portalPaths)
        expect(await proxied(path, method), `${method} ${path}`).toEqual(
          await proxied("/there-is-no-such-page", method),
        );
  });

  // #98-AD-02
  it.each([
    "/admin/",
    "/%61dmin",
    "//admin",
    "/admin//setup",
    "/admin/../admin",
    "/api//admin/settings",
    "/api/%61dmin/settings",
    "/admin/setup/anything/below",
  ])("gets the 404 for the spelling %s too", async (path) => {
    const { portal, memberCookies } = await startPortal();

    const response = await portal.visit(path, { cookies: memberCookies });

    expect(isHidden(response)).toBe(true);
  });

  // #98-AD-02
  it("gets the 404 for a Server Function posted to a portal page", async () => {
    const { portal, memberCookies } = await startPortal();

    const response = await portal.visit("/admin/setup", {
      method: "POST",
      cookies: memberCookies,
      headers: { "next-action": "00abc123", "content-type": "text/plain" },
      body: "[]",
    });

    expect(isHidden(response)).toBe(true);
  });

  // #98-AD-02
  it("gets the 404 from the data route itself when the proxy is not in front, and nothing is changed", async () => {
    const { portal, memberCookies } = await startPortal();
    const attempts = [
      { tenancy: "multi" },
      { signUp: { kind: "emails", entries: ["me@example.com"] } },
      { signInMethods: { emailPassword: true, github: false } },
      { limits: { maxWorkspacesPerUser: 99 } },
    ];

    const answers = [
      await portal.callRoute("/api/instance-portal/settings", {
        cookies: memberCookies,
      }),
      ...(await Promise.all(
        attempts.map((body) =>
          portal.callRoute("/api/instance-portal/settings", {
            method: "PUT",
            body,
            cookies: memberCookies,
          }),
        ),
      )),
    ];

    expect(answers.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404,
    ]);
    const settings = await portal.db
      .selectFrom("instance_settings")
      .selectAll()
      .execute();
    expect(settings.map((row) => row.key).sort()).toEqual([
      "setup_completed_at",
      "sign_up_rule",
      "tenancy",
    ]);
    expect((await portal.service.readSettings()).signUpRule.value).toEqual({
      kind: "everyone",
    });
  });

  it("loses access at once when the admin flag is taken away", async () => {
    const { portal } = await startPortal();
    const before = await portal.visit("/admin", {
      cookies: portal.adminCookies,
    });

    await portal.db
      .updateTable("users")
      .set({ is_instance_admin: 0 })
      .where("id", "=", portal.adminId)
      .execute();
    const after = await portal.visit("/admin", {
      cookies: portal.adminCookies,
    });
    const data = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });

    expect(isHidden(before)).toBe(false);
    expect(isHidden(after)).toBe(true);
    expect(isHidden(data)).toBe(true);
  });
});

describe("the instance admin", () => {
  async function reaches(portal: AdminHarness) {
    const page = await portal.visit("/admin/setup", {
      cookies: portal.adminCookies,
    });
    const data = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });
    return { page, data };
  }

  // #98-AD-03
  it("reaches the portal pages and the data route", async () => {
    const { portal } = await startPortal();

    const { page, data } = await reaches(portal);

    expect(await page.text()).toBe("reached");
    expect(data.status).toBe(200);
    expect(await data.json()).toMatchObject({ tenancy: { value: "single" } });
  });

  // #98-AD-19
  it("keeps access with an unverified email address while a mail server is configured, to repair it", async () => {
    const { portal } = await startPortal();
    portal.flags.mail = true;
    const row = await portal.db
      .selectFrom("users")
      .select("email_verified")
      .where("id", "=", portal.adminId)
      .executeTakeFirstOrThrow();

    const { page, data } = await reaches(portal);

    expect(row.email_verified).toBe(0);
    expect(await page.text()).toBe("reached");
    expect(data.status).toBe(200);
    expect(await data.json()).toMatchObject({ mailConfigured: true });
  });
});

describe("the synchronization with GitHub", () => {
  const SYNC = "/api/admin/integrations/sync";

  // #101-WM-08
  it("runs for the instance admin and answers with the instance-wide counts", async () => {
    const { portal } = await startPortal();

    const response = await portal.visit(SYNC, {
      method: "POST",
      cookies: portal.adminCookies,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ added: 3, errors: [] });
    expect(portal.syncCalls.count).toBe(1);
  });

  // #101-WM-08
  it("is a path that does not exist for a signed in person who does not run the instance, and does not run", async () => {
    const { portal, memberCookies } = await startPortal();

    const throughTheProxy = await portal.visit(SYNC, {
      method: "POST",
      cookies: memberCookies,
    });
    // The proxy is not in front: the route asks for the admin itself.
    const routeAlone = await portal.callRoute(
      "/api/instance-portal/integrations/sync",
      { method: "POST", cookies: memberCookies },
    );

    expect(isHidden(throughTheProxy)).toBe(true);
    expect(routeAlone.status).toBe(404);
    expect(portal.syncCalls.count).toBe(0);
  });

  // #101-WM-08
  it("answers a visitor without a session with 401 and does not run", async () => {
    const { portal } = await startPortal();

    const response = await portal.visit(SYNC, { method: "POST" });

    expect(response.status).toBe(401);
    expect(portal.syncCalls.count).toBe(0);
  });

  it("does not run for a request from another site", async () => {
    const { portal } = await startPortal();

    const response = await portal.visit(SYNC, {
      method: "POST",
      cookies: portal.adminCookies,
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });

    expect(response.status).toBe(403);
    expect(portal.syncCalls.count).toBe(0);
  });
});

describe("the backup status", () => {
  const BACKUP = "/api/backup/status";

  // #101-WM-08
  it("is a path that does not exist, in every detail, for a member of a workspace, and reached by the instance admin", async () => {
    const { portal, memberCookies } = await startPortal();

    const asMember = await portal.visit(BACKUP, { cookies: memberCookies });
    const asAdmin = await portal.visit(BACKUP, {
      cookies: portal.adminCookies,
    });

    expect(isHidden(asMember)).toBe(true);
    expect(asAdmin.status).toBe(200);
    expect(await asAdmin.text()).toBe("reached");
  });

  it("asks a visitor without a session to sign in like every protected data route", async () => {
    const { portal } = await startPortal();

    const response = await portal.visit(BACKUP);

    expect(response.status).toBe(401);
  });
});
