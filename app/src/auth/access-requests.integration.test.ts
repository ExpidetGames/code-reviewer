// SPDX-License-Identifier: Apache-2.0

// Pins down what happens to a person who is already signed in when the allow list changes or time
// passes: a login that was removed from the list loses access on the very next request, an
// organization member is asked about again after 24 hours (and not before), and every doubt is a
// no. A turned away person lands on the login page with the reason; the session is ended when the
// answer is final. Driven through the real access proxy against a real Better Auth and fake GitHub.
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccessProxy } from "./access-proxy.ts";
import { loginErrorMessage } from "./login-errors.ts";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type AuthHarness,
  type CookieJar,
} from "../test-support/auth-harness.ts";
import { openGates } from "../test-support/open-gates.ts";

const HOUR = 60 * 60 * 1000;

function visitor(harness: AuthHarness) {
  const proxy = createAccessProxy({
    getAuth: () => harness.auth,
    getPolicy: () => harness.policy,
    getGates: () => openGates,
  });
  return (path: string, cookies: CookieJar) =>
    proxy(
      new NextRequest(`${TEST_BASE_URL}${path}`, {
        headers: { cookie: cookieHeader(cookies) },
      }),
    );
}

function passesThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

function loginRedirect(response: Response): string {
  expect(response.status).toBe(307);
  return (
    new URL(response.headers.get("location") ?? "").pathname +
    new URL(response.headers.get("location") ?? "").search
  );
}

async function sessionCount(harness: AuthHarness): Promise<number> {
  return (await harness.db.selectFrom("sessions").selectAll().execute()).length;
}

async function membershipRequests(harness: AuthHarness): Promise<number> {
  return harness.github
    .requests()
    .filter((request) => request.path.startsWith("/user/memberships/")).length;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a login that is removed from ALLOWED_GITHUB_LOGINS", () => {
  // CR-19-T08
  it("loses access on the next request: pages go to the login page with the message, data routes get 403", async () => {
    const before = await createAuthHarness({ allowedLogins: ["octocat"] });
    const { cookies } = await before.signIn("octocat");
    expect(
      passesThrough(await visitor(before)("/w/default/projects", cookies)),
    ).toBe(true);
    const after = before.restart({ allowedLogins: ["hubot"] });

    const page = await visitor(after)("/w/default/projects", cookies);
    const data = await visitor(after)("/api/jobs", cookies);

    expect(loginRedirect(page)).toBe("/login?error=not_allowed");
    expect(data.status).toBe(403);
    expect(await data.json()).toEqual({
      error: "ACCESS_DENIED",
      reason: "not_allowed",
    });
    expect(loginErrorMessage("not_allowed")).toMatch(/not allowed/);
  });

  it("works again when the login is put back on the list", async () => {
    const before = await createAuthHarness({ allowedLogins: ["octocat"] });
    const { cookies } = await before.signIn("octocat");
    const removed = before.restart({ allowedLogins: [] });
    expect(
      (await visitor(removed)("/w/default/projects", cookies)).status,
    ).toBe(307);

    const restored = before.restart({ allowedLogins: ["OctoCat"] });

    expect(
      passesThrough(await visitor(restored)("/w/default/projects", cookies)),
    ).toBe(true);
  });

  // CR-19-T03
  it("is turned away when the instance is restarted with nothing configured", async () => {
    const before = await createAuthHarness({ allowedLogins: ["octocat"] });
    const { cookies } = await before.signIn("octocat");
    const after = before.restart({ allowedLogins: [] });

    const page = await visitor(after)("/w/default/projects", cookies);

    expect(loginRedirect(page)).toBe("/login?error=not_allowed");
  });
});

describe("a member of the allowed organization", () => {
  async function signedInMember() {
    const harness = await createAuthHarness({ allowedOrg: "my-org" });
    harness.github.addOrgMember("my-org", "octocat");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    const { cookies } = await harness.signIn("octocat");
    return { harness, cookies, visit: visitor(harness) };
  }

  it("is let through for 23 hours without asking GitHub again, even after leaving the organization", async () => {
    const { harness, cookies, visit } = await signedInMember();
    const asked = await membershipRequests(harness);
    harness.github.removeOrgMember("my-org", "octocat");

    vi.setSystemTime(Date.now() + 23 * HOUR);

    expect(passesThrough(await visit("/w/default/projects", cookies))).toBe(
      true,
    );
    expect(await membershipRequests(harness)).toBe(asked);
  });

  it("is asked about again after 24 hours and stays in when still a member", async () => {
    const { harness, cookies, visit } = await signedInMember();
    const asked = await membershipRequests(harness);

    vi.setSystemTime(Date.now() + 25 * HOUR);

    expect(passesThrough(await visit("/w/default/projects", cookies))).toBe(
      true,
    );
    expect(await membershipRequests(harness)).toBe(asked + 1);
    const user = await harness.db
      .selectFrom("users")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(Date.parse(user.org_checked_at ?? "")).toBe(Date.now());

    // The new check is trusted for another day.
    vi.setSystemTime(Date.now() + 2 * HOUR);
    expect(passesThrough(await visit("/w/default/projects", cookies))).toBe(
      true,
    );
    expect(await membershipRequests(harness)).toBe(asked + 1);
  });

  it("loses access and every session after 24 hours once they left the organization", async () => {
    const { harness, cookies, visit } = await signedInMember();
    await harness.signIn("octocat");
    expect(await sessionCount(harness)).toBe(2);
    harness.github.removeOrgMember("my-org", "octocat");

    vi.setSystemTime(Date.now() + 25 * HOUR);
    const page = await visit("/w/default/projects", cookies);

    expect(loginRedirect(page)).toBe("/login?error=not_allowed");
    expect(await sessionCount(harness)).toBe(0);
    const next = await visit("/w/default/projects", cookies);
    expect(loginRedirect(next)).toBe("/login");
  });

  it("is asked to sign in again after 24 hours when GitHub no longer accepts the stored token", async () => {
    const { harness, cookies, visit } = await signedInMember();
    for (const token of harness.github.issuedAccessTokens())
      harness.github.revokeToken(token);

    vi.setSystemTime(Date.now() + 25 * HOUR);
    const page = await visit("/w/default/projects", cookies);

    expect(loginRedirect(page)).toBe("/login?error=sign_in_again");
    expect(await sessionCount(harness)).toBe(0);
  });

  it("is asked to sign in again after 24 hours when the stored token cannot be read any more", async () => {
    const { harness, cookies, visit } = await signedInMember();
    // What a rotated BETTER_AUTH_SECRET leaves behind: ciphertext that no longer decrypts.
    await harness.db
      .updateTable("accounts")
      .set({ access_token: "00".repeat(40) })
      .execute();

    vi.setSystemTime(Date.now() + 25 * HOUR);
    const page = await visit("/w/default/projects", cookies);

    expect(loginRedirect(page)).toBe("/login?error=sign_in_again");
    expect(await sessionCount(harness)).toBe(0);
  });

  it("is turned away while GitHub cannot answer, without asking again for 20 seconds, keeps the session, and is let back in when it can", async () => {
    const { harness, cookies, visit } = await signedInMember();
    harness.github.failMembershipEndpoint({ kind: "status", status: 503 });

    vi.setSystemTime(Date.now() + 25 * HOUR);
    const asked = await membershipRequests(harness);
    const failed = await visit("/w/default/projects", cookies);
    const failedData = await visit("/api/jobs", cookies);

    expect(loginRedirect(failed)).toBe("/login?error=check_failed");
    expect(failedData.status).toBe(403);
    expect(await sessionCount(harness)).toBe(1);
    expect(await membershipRequests(harness)).toBe(asked + 1);

    harness.github.failMembershipEndpoint(null);
    vi.setSystemTime(Date.now() + 10_000);
    expect(loginRedirect(await visit("/w/default/projects", cookies))).toBe(
      "/login?error=check_failed",
    );
    expect(await membershipRequests(harness)).toBe(asked + 1);

    vi.setSystemTime(Date.now() + 11_000);
    expect(passesThrough(await visit("/w/default/projects", cookies))).toBe(
      true,
    );
    expect(await membershipRequests(harness)).toBe(asked + 2);
  });

  it("is asked about again at once when ALLOWED_GITHUB_ORG names another organization", async () => {
    const { harness, cookies } = await signedInMember();
    const other = harness.restart({ allowedOrg: "other-org" });
    const asked = await membershipRequests(harness);

    const page = await visitor(other)("/w/default/projects", cookies);

    expect(loginRedirect(page)).toBe("/login?error=not_allowed");
    expect(await membershipRequests(harness)).toBe(asked + 1);
    expect(await sessionCount(harness)).toBe(0);
  });

  it("is let through for the other organization when they are a member there, and notes it", async () => {
    const { harness, cookies } = await signedInMember();
    harness.github.addOrgMember("other-org", "octocat");
    const other = harness.restart({ allowedOrg: "other-org" });

    expect(
      passesThrough(await visitor(other)("/w/default/projects", cookies)),
    ).toBe(true);

    const user = await harness.db
      .selectFrom("users")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(user.org_checked_for).toBe("other-org");
  });

  it("is turned away when GitHub does not answer in time", async () => {
    const harness = await createAuthHarness({
      allowedOrg: "my-org",
      githubRequestTimeoutMs: 200,
    });
    harness.github.addOrgMember("my-org", "octocat");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    const { cookies } = await harness.signIn("octocat");
    harness.github.failMembershipEndpoint({ kind: "delay", delayMs: 6000 });
    vi.setSystemTime(Date.now() + 25 * HOUR);

    const page = await visitor(harness)("/w/default/projects", cookies);

    expect(loginRedirect(page)).toBe("/login?error=check_failed");
  });

  it("asks GitHub once for requests that arrive together", async () => {
    const { harness, cookies, visit } = await signedInMember();
    const asked = await membershipRequests(harness);
    vi.setSystemTime(Date.now() + 25 * HOUR);

    const responses = await Promise.all([
      visit("/w/default/projects", cookies),
      visit("/api/jobs", cookies),
      visit("/w/default/projects", cookies),
    ]);

    expect(responses.every(passesThrough)).toBe(true);
    expect(await membershipRequests(harness)).toBe(asked + 1);
  });

  it("is never allowed by a stored check time alone when the organization setting was removed", async () => {
    const { harness, cookies } = await signedInMember();
    const withoutOrg = harness.restart({
      allowedLogins: [],
      allowedOrg: undefined,
    });

    const page = await visitor(withoutOrg)("/w/default/projects", cookies);

    expect(loginRedirect(page)).toBe("/login?error=not_allowed");
  });
});

describe("a person who signed in before the organization was configured", () => {
  it("is asked to sign in again because the token has no organization scope, and the new sign in works", async () => {
    const before = await createAuthHarness({ allowedLogins: ["octocat"] });
    const { cookies } = await before.signIn("octocat");
    before.github.addOrgMember("my-org", "octocat");
    const orgMode = before.restart({ allowedLogins: [], allowedOrg: "my-org" });

    const page = await visitor(orgMode)("/w/default/projects", cookies);

    expect(loginRedirect(page)).toBe("/login?error=sign_in_again");
    expect(await sessionCount(orgMode)).toBe(0);
    const again = await orgMode.signIn("octocat");
    expect(again.response.headers.get("location")).toBe("/");
    expect(
      passesThrough(
        await visitor(orgMode)("/w/default/projects", again.cookies),
      ),
    ).toBe(true);
  });
});

describe("a listed login when the organization is configured as well", () => {
  // CR-19-T12
  it("is let through on every request without any call to GitHub", async () => {
    const harness = await createAuthHarness({
      allowedLogins: ["octocat"],
      allowedOrg: "my-org",
    });
    const { cookies } = await harness.signIn("octocat");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    vi.setSystemTime(Date.now() + 48 * HOUR);

    expect(
      passesThrough(await visitor(harness)("/w/default/projects", cookies)),
    ).toBe(true);
    expect(await membershipRequests(harness)).toBe(0);
  });
});
