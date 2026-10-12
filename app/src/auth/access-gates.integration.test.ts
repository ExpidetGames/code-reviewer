// SPDX-License-Identifier: Apache-2.0

// Pins down the two gates in front of the app for an email and password account, with real requests
// through the real proxy over a real database and the real Better Auth: a verified address (while the
// instance can send mail, with the instance admin keeping the admin portal) and a workspace (an account
// made by the sign-up has none and sees no data). Accounts without a password, the GitHub ones, are not
// asked either, and a gate that cannot be read serves nobody.
import { describe, expect, it } from "vitest";
import { createAdminHarness } from "../test-support/admin-harness.ts";
import { createAuthHarness } from "../test-support/auth-harness.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { lookupSession } from "./session-user.ts";
import { cookieHeader } from "../test-support/auth-harness.ts";

const PERSON = { email: "person@example.com", password: "k4Pq-v8Zm2Xw" };

async function start(options: { mail?: boolean } = {}) {
  // The harness signs the admin in before the mail server is switched on: an unverified address does not
  // sign in while the instance can send mail (src/auth/unverified-sign-in.ts), and these tests are about
  // the sessions that exist.
  const portal = await createAdminHarness();
  portal.flags.mail = options.mail ?? false;
  return portal;
}

type Portal = Awaited<ReturnType<typeof start>>;

async function signUpPerson(
  portal: Portal,
  state: { verified: boolean; member: boolean },
) {
  await portal.createUser({
    id: "person-1",
    ...PERSON,
    emailVerified: state.verified,
    member: state.member,
  });
  const mail = portal.flags.mail;
  portal.flags.mail = false;
  const cookies = await portal.signIn(PERSON.email, PERSON.password);
  portal.flags.mail = mail;
  return cookies;
}

async function location(response: Response): Promise<string | null> {
  const target = response.headers.get("location");
  return target === null ? null : new URL(target).pathname;
}

describe("an email and password account whose address is not verified while the instance can send mail", () => {
  // #99-SR-23
  it("is sent to the verification page by every page of the app", async () => {
    const portal = await start({ mail: true });
    const cookies = await signUpPerson(portal, {
      verified: false,
      member: true,
    });

    for (const path of [
      "/",
      "/projects",
      "/runs",
      "/settings",
      "/w/default/projects",
      "/w/default/members",
      "/anything",
    ]) {
      const response = await portal.visit(path, { cookies });
      expect(response.status, path).toBe(307);
      expect(await location(response), path).toBe("/verify-email");
    }
  });

  // #99-SR-23
  it("is refused by every data route with 403 email_not_verified, and by a write too", async () => {
    const portal = await start({ mail: true });
    const cookies = await signUpPerson(portal, {
      verified: false,
      member: true,
    });

    for (const [path, method] of [
      ["/api/w/default/runs", "GET"],
      ["/api/w/default/review-settings", "PUT"],
      ["/api/w/default/invitations", "POST"],
      ["/api/workspaces", "POST"],
    ] as const) {
      const response = await portal.visit(path, { cookies, method });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({
        error: "email_not_verified",
      });
    }
  });

  // #99-SR-24
  it("has the same answer for the admin portal as for any other path", async () => {
    const portal = await start({ mail: true });
    const cookies = await signUpPerson(portal, {
      verified: false,
      member: true,
    });

    const adminPage = await portal.visit("/admin/setup", { cookies });
    const missing = await portal.visit("/there-is-no-such-page", { cookies });

    expect(adminPage.status).toBe(307);
    expect(await location(adminPage)).toBe(await location(missing));
  });

  // #99-SR-11
  it("uses the app once the address is verified", async () => {
    const portal = await start({ mail: true });
    const cookies = await signUpPerson(portal, {
      verified: false,
      member: true,
    });
    await portal.db
      .updateTable("users")
      .set({ email_verified: 1 })
      .where("id", "=", "person-1")
      .execute();

    const response = await portal.visit("/projects", { cookies });

    expect(await response.text()).toBe("reached");
  });

  // #99-SR-08
  it("uses the app at once when the instance has no mail server, with the address unverified", async () => {
    const portal = await start({ mail: false });
    const cookies = await signUpPerson(portal, {
      verified: false,
      member: true,
    });

    const response = await portal.visit("/projects", { cookies });

    expect(await response.text()).toBe("reached");
  });

  // #99-SR-24
  it("is asked at once, also with a session that was opened before the mail server was added", async () => {
    const portal = await start({ mail: false });
    const cookies = await signUpPerson(portal, {
      verified: false,
      member: true,
    });
    expect(await (await portal.visit("/projects", { cookies })).text()).toBe(
      "reached",
    );

    portal.flags.mail = true;
    const response = await portal.visit("/projects", { cookies });

    expect(await location(response)).toBe("/verify-email");
  });

  // #99-SR-24
  it("is let in again at once when the mail server is removed", async () => {
    const portal = await start({ mail: true });
    const cookies = await signUpPerson(portal, {
      verified: false,
      member: true,
    });

    portal.flags.mail = false;
    const response = await portal.visit("/projects", { cookies });

    expect(await response.text()).toBe("reached");
  });
});

describe("the instance admin whose address is not verified while the instance can send mail", () => {
  // #99-SR-24
  it("still reaches the admin portal, its pages and its data route", async () => {
    const portal = await start({ mail: true });

    const page = await portal.visit("/admin/setup", {
      cookies: portal.adminCookies,
    });
    const data = await portal.visit("/api/admin/settings", {
      cookies: portal.adminCookies,
    });

    expect(await page.text()).toBe("reached");
    expect(data.status).toBe(200);
    expect(await data.json()).toMatchObject({ mailConfigured: true });
  });

  // #99-SR-24
  it("is asked to verify everywhere else", async () => {
    const portal = await start({ mail: true });

    const page = await portal.visit("/projects", {
      cookies: portal.adminCookies,
    });
    const data = await portal.visit("/api/w/default/runs", {
      cookies: portal.adminCookies,
    });

    expect(await location(page)).toBe("/verify-email");
    expect(data.status).toBe(403);
    expect(await data.json()).toEqual({ error: "email_not_verified" });
  });

  // #99-SR-24
  it("is not let past the portal by a path that only looks like it", async () => {
    const portal = await start({ mail: true });

    for (const path of ["/admin-not", "/administrator", "/api/administrator"]) {
      const response = await portal.visit(path, {
        cookies: portal.adminCookies,
      });
      expect(response.status, path).not.toBe(200);
    }
  });

  // #99-SR-25
  it("is not asked to verify when the instance cannot send mail", async () => {
    const portal = await start({ mail: false });

    const response = await portal.visit("/projects", {
      cookies: portal.adminCookies,
    });

    expect(await response.text()).toBe("reached");
  });

  // #99-SR-24
  it("is the admin again as soon as the address is verified", async () => {
    const portal = await start({ mail: true });
    await portal.db
      .updateTable("users")
      .set({ email_verified: 1 })
      .where("id", "=", portal.adminId)
      .execute();

    const response = await portal.visit("/projects", {
      cookies: portal.adminCookies,
    });

    expect(await response.text()).toBe("reached");
  });

  it("does not need a workspace to use the app", async () => {
    const portal = await start({ mail: false });
    await portal.db.deleteFrom("workspace_members").execute();

    const response = await portal.visit("/projects", {
      cookies: portal.adminCookies,
    });

    expect(await response.text()).toBe("reached");
  });
});

describe("an email and password account without a workspace", () => {
  // #99-SR-21
  it("is sent to the page that asks for an invitation by every page of the app", async () => {
    const portal = await start();
    const cookies = await signUpPerson(portal, {
      verified: true,
      member: false,
    });

    for (const path of [
      "/",
      "/projects",
      "/runs/some-run",
      "/settings",
      "/w/default/projects",
    ]) {
      const response = await portal.visit(path, { cookies });
      expect(response.status, path).toBe(307);
      expect(await location(response), path).toBe("/no-access");
    }
  });

  // #99-SR-21
  it("is refused by every data route with 403 no_workspace_access", async () => {
    const portal = await start();
    const cookies = await signUpPerson(portal, {
      verified: true,
      member: false,
    });

    for (const [path, method] of [
      ["/api/w/default/runs", "GET"],
      ["/api/w/default/review-settings", "PUT"],
      ["/api/w/default/invitations", "POST"],
      ["/api/backup/status", "GET"],
    ] as const) {
      const response = await portal.visit(path, { cookies, method });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({
        error: "no_workspace_access",
      });
    }
  });

  // #99-SR-21
  it("gets nothing of the admin portal either: the answer is the one of any other path", async () => {
    const portal = await start();
    const cookies = await signUpPerson(portal, {
      verified: true,
      member: false,
    });

    const portalPage = await portal.visit("/admin", { cookies });
    const missing = await portal.visit("/there-is-no-such-page", { cookies });

    expect(portalPage.status).toBe(missing.status);
    expect(await location(portalPage)).toBe(await location(missing));
    expect(portalPage.headers.get("x-middleware-rewrite")).toBeNull();
  });

  // #99-SR-21
  it("is not joined to a workspace by signing in", async () => {
    const portal = await start();
    const cookies = await signUpPerson(portal, {
      verified: true,
      member: false,
    });

    await portal.visit("/projects", { cookies });

    const members = await portal.db
      .selectFrom("workspace_members")
      .select("user_id")
      .where("user_id", "=", "person-1")
      .execute();
    expect(members).toEqual([]);
  });

  it("uses the app as soon as it belongs to a workspace", async () => {
    const portal = await start();
    const cookies = await signUpPerson(portal, {
      verified: true,
      member: false,
    });
    const workspace = await createWorkspacesRepository(portal.db).findDefault();
    await createWorkspacesRepository(portal.db).addMember(
      workspace?.id ?? "",
      "person-1",
      "member",
    );

    const response = await portal.visit("/projects", { cookies });

    expect(await response.text()).toBe("reached");
  });

  it("asks for the verification before it asks for a workspace", async () => {
    const portal = await start({ mail: true });
    const cookies = await signUpPerson(portal, {
      verified: false,
      member: false,
    });

    const response = await portal.visit("/projects", { cookies });

    expect(await location(response)).toBe("/verify-email");
  });
});

describe("an account that signs in with GitHub", () => {
  // #101-WM-02
  it("is asked for a workspace like every account, and not for a verified address", async () => {
    const harness = await createAuthHarness();
    const { cookies } = await harness.signIn();
    const gates = (workspace: boolean) => ({
      verificationRequired: () => Promise.resolve(true),
      hasWorkspace: () => Promise.resolve(workspace),
      workspaceRole: () =>
        Promise.resolve(workspace ? ("member" as const) : null),
    });
    const lookup = (workspace: boolean) =>
      lookupSession(
        harness.auth,
        new Headers({ cookie: cookieHeader(cookies) }),
        harness.policy,
        gates(workspace),
      );

    expect((await lookup(true)).kind).toBe("user");
    expect((await lookup(false)).kind).toBe("no_workspace");
  });
});

describe("a gate that cannot be read", () => {
  it("serves nobody: the proxy answers 503", async () => {
    const portal = await start({ mail: false });
    const cookies = await signUpPerson(portal, {
      verified: true,
      member: true,
    });
    await portal.db.schema.dropTable("workspace_members").execute();

    const response = await portal.visit("/projects", { cookies });

    expect(response.status).toBe(503);
  });
});
