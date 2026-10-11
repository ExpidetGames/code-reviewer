// Pins down who reaches the admin portal, with real requests through the real proxy and the real data
// route over a real database and the real Better Auth: a visitor without a session is sent to the
// sign-in (a page) or gets 401 (a data route); a signed in person who is not an instance admin gets
// the 404 of a path that does not exist, on every page and every data route below the portal, with any
// method, in any spelling, and also from the data route itself when the proxy is not in front; the admin
// gets in, with an unverified email address too. The routes are read from the file system, so a page or
// route added to the portal without a decision here fails the test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_HIDDEN_PATH } from "../auth/access-proxy.ts";
import {
  createAdminHarness,
  type AdminHarness,
} from "../test-support/admin-harness.ts";
import { concretePath, discoverRoutes } from "../test-support/routes.ts";
import { isAdminPath } from "./paths.ts";

const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const adminRoutes = discoverRoutes().filter(({ route }) =>
  isAdminPath(concretePath(route)),
);
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

function isHidden(response: Response): boolean {
  const rewrite = response.headers.get("x-middleware-rewrite");
  return rewrite !== null && new URL(rewrite).pathname === ADMIN_HIDDEN_PATH;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the routes of the portal", () => {
  it("are found on the file system: the pages of the five sections and the settings route", () => {
    expect(adminRoutes.map(({ route }) => route).sort()).toEqual([
      "/admin",
      "/admin/integrations",
      "/admin/limits",
      "/admin/mail",
      "/admin/setup",
      "/api/admin/settings",
    ]);
  });
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

    const get = await portal.callRoute("/api/admin/settings");
    const put = await portal.callRoute("/api/admin/settings", {
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
  it("gets the same answer for a portal path as the rewrite to a path that is no route", async () => {
    const { portal, memberCookies } = await startPortal();

    const portalPage = await portal.visit("/admin", { cookies: memberCookies });
    const portalData = await portal.visit("/api/admin/settings", {
      cookies: memberCookies,
    });

    expect(portalPage.headers.get("x-middleware-rewrite")).toBe(
      portalData.headers.get("x-middleware-rewrite"),
    );
    expect(portalPage.headers.get("location")).toBeNull();
    expect(portalPage.headers.get("cache-control")).toBe("no-store");
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
      await portal.callRoute("/api/admin/settings", { cookies: memberCookies }),
      ...(await Promise.all(
        attempts.map((body) =>
          portal.callRoute("/api/admin/settings", {
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
