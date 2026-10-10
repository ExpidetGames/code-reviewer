// Pins down that the sign in and the GitHub integration run against one and the same fake GitHub:
// one server, one address for `GITHUB_OAUTH_BASE_URL` and `GITHUB_API_BASE_URL`, no second fake.
import { describe, expect, it } from "vitest";
import { startGithubFake } from "../../../fakes/github/server.ts";
import {
  createAuthHarness,
  OCTOCAT,
  TEST_CLIENT_ID,
} from "../../src/test-support/auth-harness.ts";
import { TEST_APP_ID, testAppKeys } from "../../src/test-support/github-app.ts";
import { startTestGithub } from "../../src/test-support/github-fake.ts";
import { startGithubAppHarness } from "../../src/test-support/github-app-harness.ts";

describe("one fake GitHub for the sign in and the GitHub integration", () => {
  // CR-43-T04
  it("lets a person sign in and the app list the installations of the GitHub App on the same address", async () => {
    const github = await startTestGithub();
    const auth = await createAuthHarness({ github });
    const app = await startGithubAppHarness({ fake: github });
    github.addInstallation({
      id: 4242,
      account: { login: "acme", id: 5001, type: "Organization" },
    });
    github.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);

    const signedIn = await auth.signIn(OCTOCAT.login);
    const listed = await fetch(
      `${app.env.GITHUB_API_BASE_URL}/app/installations`,
    );

    expect(signedIn.response.status).toBe(302);
    expect(auth.config.github.oauthBaseUrl).toBe(github.baseUrl);
    expect(auth.config.github.apiBaseUrl).toBe(github.baseUrl);
    expect(app.env.GITHUB_API_BASE_URL).toBe(github.baseUrl);
    // The App API answers on the shared address (401: no App JWT), the sign in worked on it too.
    expect(listed.status).toBe(401);
    expect(github.issuedAccessTokens()).toHaveLength(1);
    expect(github.requests().map((request) => request.path)).toEqual(
      expect.arrayContaining([
        "/login/oauth/authorize/confirm",
        "/login/oauth/access_token",
        "/user",
        "/app/installations",
      ]),
    );
  });

  // CR-43-T04
  it("clears the users, the recorded requests and the injected failures of both parts with one reset", async () => {
    const github = await startTestGithub();
    github.addUser(OCTOCAT);
    github.fail({ pathIncludes: "/app/installations", status: 503 });
    await fetch(`${github.baseUrl}/app/installations`);

    github.reset();

    expect(github.requests()).toEqual([]);
    const authorize = await fetch(
      `${github.baseUrl}/login/oauth/authorize?client_id=${TEST_CLIENT_ID}&redirect_uri=http://localhost/cb`,
    );
    expect(await authorize.text()).not.toContain("Authorize octocat");
    const installations = await fetch(`${github.baseUrl}/app/installations`);
    expect(installations.status).toBe(401); // the injected 503 is gone
  });

  it("answers 404 for a part that is not switched on", async () => {
    const signInOnly = await startGithubFake({
      clientId: "id",
      clientSecret: "secret",
    });
    try {
      const response = await fetch(`${signInOnly.baseUrl}/app/installations`);

      expect(response.status).toBe(404);
    } finally {
      await signInOnly.close();
    }
  });

  it("answers 404 for the sign in paths when only the GitHub App API is switched on", async () => {
    const appOnly = await startGithubFake({
      appId: TEST_APP_ID,
      publicKeyPem: testAppKeys().publicKey,
    });
    try {
      for (const path of [
        "/login/oauth/authorize?client_id=x&redirect_uri=http://localhost/cb",
        "/user",
        "/user/emails",
        "/user/memberships/orgs/acme",
        "/__fake/users",
      ]) {
        const response = await fetch(`${appOnly.baseUrl}${path}`);
        expect(response.status, path).toBe(404);
      }
      const token = await fetch(`${appOnly.baseUrl}/login/oauth/access_token`, {
        method: "POST",
      });
      expect(token.status).toBe(404);
    } finally {
      await appOnly.close();
    }
  });

  // CR-43-T04
  it("keeps its control endpoints out of the injected failures", async () => {
    const github = await startTestGithub();
    github.fail({ status: 503 }); // every request, any path

    const health = await fetch(`${github.baseUrl}/__fake/health`);
    const api = await fetch(`${github.baseUrl}/app/installations`);
    const reset = await fetch(`${github.baseUrl}/__fake/reset`, {
      method: "POST",
    });

    expect(health.status).toBe(200);
    expect(api.status).toBe(503);
    expect(reset.status).toBe(200);
    // The reset cleared the failure, so the API answers normally again (401: no App JWT).
    expect((await fetch(`${github.baseUrl}/app/installations`)).status).toBe(
      401,
    );
  });

  it("refuses half a pair of options", async () => {
    await expect(startGithubFake({ clientId: "id" })).rejects.toThrow(
      "clientId and clientSecret together",
    );
    await expect(startGithubFake({ appId: "1" })).rejects.toThrow(
      "appId and publicKeyPem together",
    );
  });
});
