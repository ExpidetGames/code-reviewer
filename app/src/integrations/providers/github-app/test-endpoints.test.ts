// Pins down that the sign in and the GitHub App read the same test endpoint variables with the same
// rule (this file lives in the provider folder because it needs the GitHub App settings).
// GITHUB_API_BASE_URL and GITHUB_OAUTH_BASE_URL point at the fake GitHub, and only together with
// ALLOW_TEST_GITHUB_ENDPOINTS=true, because secrets are sent to those addresses. Without the flag the
// server refuses to start with one line that names the variable and the flag.
import { describe, expect, it, vi } from "vitest";
import { loadAuthConfig } from "../../../auth/config.ts";
import { checkAuthConfigOnStart } from "../../../auth/startup.ts";
import { testGithubAppEnv } from "../../../test-support/github-app.ts";
import { loadGithubAppConfig } from "./config.ts";

const signInEnv = {
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_OAUTH_CLIENT_ID: "id",
  GITHUB_OAUTH_CLIENT_SECRET: "secret-value",
  ALLOWED_GITHUB_LOGINS: "octocat",
};

const FAKE = "http://127.0.0.1:4010";

describe("the test endpoints of GitHub", () => {
  // CR-43-T03
  it.each(["GITHUB_API_BASE_URL", "GITHUB_OAUTH_BASE_URL"])(
    "stop the start with a clear message when %s is set without ALLOW_TEST_GITHUB_ENDPOINTS",
    (name) => {
      const exit = vi.fn();
      const log = vi.fn();

      checkAuthConfigOnStart({
        env: { ...signInEnv, [name]: FAKE },
        log,
        exit,
      });

      expect(exit).toHaveBeenCalledWith(1);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain("AUTH_CONFIG_INVALID");
      expect(line).toContain(name);
      expect(line).toContain("ALLOW_TEST_GITHUB_ENDPOINTS=true");
      expect(line).not.toContain(FAKE);
    },
  );

  // CR-43-T03
  it("are refused by the GitHub App settings too, naming the variable and the flag", () => {
    expect(() =>
      loadGithubAppConfig(testGithubAppEnv({ GITHUB_API_BASE_URL: FAKE })),
    ).toThrow(
      expect.objectContaining({
        code: "GITHUB_APP_CONFIG_INVALID",
        variables: ["GITHUB_API_BASE_URL", "ALLOW_TEST_GITHUB_ENDPOINTS"],
      }),
    );
  });

  // CR-43-T03
  it("are accepted by both settings with the same value once the flag is set", () => {
    const flag = { ALLOW_TEST_GITHUB_ENDPOINTS: "true" };

    const signIn = loadAuthConfig({
      ...signInEnv,
      ...flag,
      GITHUB_API_BASE_URL: `${FAKE}/`,
      GITHUB_OAUTH_BASE_URL: FAKE,
    });
    const app = loadGithubAppConfig(
      testGithubAppEnv({ ...flag, GITHUB_API_BASE_URL: `${FAKE}/` }),
    );

    expect(signIn.github.apiBaseUrl).toBe(FAKE);
    expect(signIn.github.oauthBaseUrl).toBe(FAKE);
    expect(app.apiBaseUrl).toBe(FAKE);
  });

  it("allow naming the real GitHub API explicitly without the flag, in both settings", () => {
    const explicit = "https://api.github.com";

    expect(
      loadAuthConfig({ ...signInEnv, GITHUB_API_BASE_URL: explicit }).github
        .apiBaseUrl,
    ).toBe(explicit);
    expect(
      loadGithubAppConfig(testGithubAppEnv({ GITHUB_API_BASE_URL: explicit }))
        .apiBaseUrl,
    ).toBe(explicit);
  });

  it("no longer know the old name GITHUB_API_BASE", () => {
    const config = loadAuthConfig({ ...signInEnv, GITHUB_API_BASE: FAKE });

    expect(config.github.apiBaseUrl).toBe("https://api.github.com");
  });
});
