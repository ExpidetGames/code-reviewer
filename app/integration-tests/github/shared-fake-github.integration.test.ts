// Pins down that the sign in and the GitHub integration run against one and the same fake GitHub:
// one server, one address for `GITHUB_OAUTH_BASE_URL` and `GITHUB_API_BASE_URL`, no second fake.
import { describe, expect, it } from "vitest";
import { startGithubFake } from "../../../fakes/github/server.ts";
import {
  createAuthHarness,
  OCTOCAT,
  TEST_CLIENT_ID,
} from "../../src/test-support/auth-harness.ts";
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

  it("refuses half a pair of options", async () => {
    await expect(startGithubFake({ clientId: "id" })).rejects.toThrow(
      "clientId and clientSecret together",
    );
    await expect(startGithubFake({ appId: "1" })).rejects.toThrow(
      "appId and publicKeyPem together",
    );
  });
});
