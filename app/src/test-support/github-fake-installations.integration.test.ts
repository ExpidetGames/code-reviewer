// SPDX-License-Identifier: Apache-2.0

// Pins down what the fake GitHub does for the binding of installations (fakes/github/README.md), because the
// tests of the binding stand on it: the installation page and where it sends the browser, which installations
// a user token lists, and how the role in an organization is reported (owner, member, not a member, unreadable).
import { describe, expect, it } from "vitest";
import { startTestGithub } from "./github-fake.ts";
import { TEST_APP_SLUG } from "./github-app.ts";

const SETUP = "https://reviews.example.test/github/connected";

async function sessionOf(
  github: Awaited<ReturnType<typeof startTestGithub>>,
  login: string,
) {
  const authorize = new URL(`${github.baseUrl}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", "test-client-id");
  authorize.searchParams.set("redirect_uri", "https://reviews.example.test/cb");
  authorize.searchParams.set("state", "s");
  const callback = await github.authorize(authorize.toString(), login);
  const response = await fetch(`${github.baseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: "test-client-id",
      client_secret: "test-client-secret-value",
      code: callback.searchParams.get("code"),
      redirect_uri: "https://reviews.example.test/cb",
    }),
  });
  const { access_token } = (await response.json()) as { access_token: string };
  const get = async (path: string) => {
    const answer = await fetch(`${github.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${access_token}` },
    });
    return {
      status: answer.status,
      body: (await answer.json()) as Record<string, unknown>,
    };
  };
  return { get };
}

async function world() {
  const github = await startTestGithub({ appSlug: TEST_APP_SLUG });
  github.addUser({ id: 1, login: "owner", name: null, email: null });
  github.addUser({ id: 2, login: "member", name: null, email: null });
  github.addUser({ id: 3, login: "stranger", name: null, email: null });
  github.addInstallation({
    id: 10,
    account: { login: "owner", id: 1, type: "User" },
  });
  github.addInstallation({
    id: 20,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  github.addOrgMember("acme", "owner", "active", "admin");
  github.addOrgMember("acme", "member", "active", "member");
  return github;
}

describe("the installation page of the fake", () => {
  // #103-IB-10
  it("sends the browser to the setup URL of the App with the installation, the action and the state", async () => {
    const github = await world();
    github.setAppSetupUrl(SETUP);

    const page = await fetch(
      `${github.baseUrl}/apps/${TEST_APP_SLUG}/installations/new?state=abc`,
    );
    const html = await page.text();
    const install = await fetch(
      `${github.baseUrl}/apps/${TEST_APP_SLUG}/installations/confirm`,
      {
        method: "POST",
        body: new URLSearchParams({
          state: "abc",
          installation_id: "20",
          action: "install",
        }),
        redirect: "manual",
      },
    );
    const request = await fetch(
      `${github.baseUrl}/apps/${TEST_APP_SLUG}/installations/confirm`,
      {
        method: "POST",
        body: new URLSearchParams({
          state: "abc",
          installation_id: "20",
          action: "request",
        }),
        redirect: "manual",
      },
    );

    expect(html).toContain("Install on acme");
    expect(html).toContain("Ask acme to approve");
    const installed = new URL(install.headers.get("location") ?? "");
    expect(installed.origin + installed.pathname).toBe(SETUP);
    expect(Object.fromEntries(installed.searchParams)).toEqual({
      installation_id: "20",
      setup_action: "install",
      state: "abc",
    });
    // Like GitHub, a request for approval has no installation yet.
    expect(
      Object.fromEntries(
        new URL(request.headers.get("location") ?? "").searchParams,
      ),
    ).toEqual({
      setup_action: "request",
      state: "abc",
    });
  });

  // #103-IB-10
  it("does not know an App that is not registered, and has nowhere to send the browser without a setup URL", async () => {
    const github = await world();

    const unknown = await fetch(
      `${github.baseUrl}/apps/nobody/installations/new`,
    );
    const noUrl = await fetch(
      `${github.baseUrl}/apps/${TEST_APP_SLUG}/installations/confirm`,
      {
        method: "POST",
        body: new URLSearchParams({ installation_id: "20", action: "install" }),
        redirect: "manual",
      },
    );

    expect(unknown.status).toBe(404);
    expect(noUrl.status).toBe(400);
  });
});

describe("the installations a user token lists", () => {
  // #103-IB-05
  it("holds the personal account, the organizations the user belongs to, and what was granted", async () => {
    const github = await world();
    github.grantInstallationAccess(10, "stranger");

    const owner = await (
      await sessionOf(github, "owner")
    ).get("/user/installations");
    const member = await (
      await sessionOf(github, "member")
    ).get("/user/installations");
    const stranger = await (
      await sessionOf(github, "stranger")
    ).get("/user/installations");

    const ids = (answer: { body: Record<string, unknown> }) =>
      (answer.body.installations as Array<{ id: number }>).map((i) => i.id);
    expect(ids(owner)).toEqual([10, 20]);
    expect(ids(member)).toEqual([20]);
    expect(ids(stranger)).toEqual([10]);
  });

  // #103-IB-05
  it("does not list an organization to a person whose invitation is pending", async () => {
    const github = await world();
    github.addOrgMember("acme", "stranger", "pending", "admin");

    const stranger = await (
      await sessionOf(github, "stranger")
    ).get("/user/installations");

    expect(stranger.body.installations).toEqual([]);
  });
});

describe("the role in an organization", () => {
  // #103-IB-03, #103-IB-04
  it("reports an owner as admin, a member as member, and a person who does not belong as 404", async () => {
    const github = await world();

    const owner = await (
      await sessionOf(github, "owner")
    ).get("/user/memberships/orgs/acme");
    const member = await (
      await sessionOf(github, "member")
    ).get("/user/memberships/orgs/acme");
    const stranger = await (
      await sessionOf(github, "stranger")
    ).get("/user/memberships/orgs/acme");

    expect(owner).toMatchObject({
      status: 200,
      body: { role: "admin", state: "active" },
    });
    expect(member).toMatchObject({ status: 200, body: { role: "member" } });
    expect(stranger.status).toBe(404);
  });

  // #103-IB-19
  it("answers 403 for an organization whose roles are unreadable, or when the App lacks the permission, and 404 elsewhere", async () => {
    const github = await world();
    github.addInstallation({
      id: 30,
      account: { login: "opaque", id: 5002, type: "Organization" },
    });
    github.addOrgMember("opaque", "owner", "active", "admin");
    github.makeMembershipUnreadable("opaque");
    const owner = await sessionOf(github, "owner");

    const opaque = await owner.get("/user/memberships/orgs/opaque");
    const readable = await owner.get("/user/memberships/orgs/acme");
    github.setAppAccountPermissions({ emails: "read" });
    const withoutPermission = await owner.get("/user/memberships/orgs/acme");

    expect(opaque.status).toBe(403);
    expect(readable.status).toBe(200);
    expect(withoutPermission.status).toBe(403);
  });

  // #103-IB-19
  it("reports the owner of the App with an id on GET /app", async () => {
    const github = await world();

    expect(github.registeredApps()[0]).toMatchObject({
      ownerLogin: "fake-owner",
      ownerId: expect.any(Number),
    });
  });
});
