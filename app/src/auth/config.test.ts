// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how the sign-in settings are read from the environment: what is required, what a
// missing value reports, which defaults point at the real GitHub, and that no secret is ever echoed.
import { describe, expect, it } from "vitest";
import { AuthConfigError, loadAuthConfig } from "./config.ts";

const SECRET = "s".repeat(40);
const validEnv = {
  APP_SECRET: SECRET,
  BETTER_AUTH_URL: "http://localhost:3000",
};

function loadError(env: Record<string, string | undefined>): AuthConfigError {
  try {
    loadAuthConfig(env);
  } catch (error) {
    if (error instanceof AuthConfigError) return error;
    throw error;
  }
  throw new Error("loadAuthConfig did not throw");
}

describe("loading the sign-in configuration", () => {
  it("reads the master key and the public address, and points GitHub at the real endpoints by default", () => {
    const config = loadAuthConfig(validEnv);

    expect(config).toMatchObject({
      secret: SECRET,
      baseUrl: "http://localhost:3000",
      github: {
        oauthBaseUrl: "https://github.com",
        apiBaseUrl: "https://api.github.com",
      },
    });
  });

  // #102-GH-16
  it("does not read the variables of the GitHub OAuth app of the previous release, whatever they hold", () => {
    const config = loadAuthConfig({
      ...validEnv,
      GITHUB_OAUTH_CLIENT_ID: "dummy-client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "dummy-client-secret-value",
    });

    expect(JSON.stringify(config)).not.toContain("dummy-client");
  });

  // #97-SU-17
  it("names every missing required variable at once, never a value", () => {
    const error = loadError({});

    expect(error.code).toBe("AUTH_CONFIG_INVALID");
    expect(error.message).toContain("APP_SECRET");
    expect(error.message).toContain("BETTER_AUTH_URL");
    expect(error.message).not.toContain("GITHUB");
  });

  // #97-SU-17
  it("accepts BETTER_AUTH_SECRET in place of APP_SECRET, and prefers APP_SECRET", () => {
    const { APP_SECRET: _unused, ...withoutSecret } = validEnv;
    void _unused;
    const legacy = "legacy-".padEnd(40, "l");

    expect(
      loadAuthConfig({ ...withoutSecret, BETTER_AUTH_SECRET: legacy }).secret,
    ).toBe(legacy);
    expect(
      loadAuthConfig({ ...validEnv, BETTER_AUTH_SECRET: legacy }).secret,
    ).toBe(SECRET);
  });

  it("rejects a master key that is too short without echoing it", () => {
    const error = loadError({ ...validEnv, APP_SECRET: "short" });

    expect(error.message).toContain("APP_SECRET");
    expect(error.message).toMatch(/at least 32/);
    expect(error.message).not.toContain("short");
  });

  it("rejects a base URL that is not an http or https URL", () => {
    expect(
      loadError({ ...validEnv, BETTER_AUTH_URL: "not a url" }).message,
    ).toContain("BETTER_AUTH_URL");
    expect(
      loadError({ ...validEnv, BETTER_AUTH_URL: "ftp://example.com" }).message,
    ).toContain("BETTER_AUTH_URL");
  });

  it("reduces the base URL to its origin so the callback address is predictable", () => {
    const config = loadAuthConfig({
      ...validEnv,
      BETTER_AUTH_URL: "https://reviews.example.com/",
    });

    expect(config.baseUrl).toBe("https://reviews.example.com");
  });

  it("takes the GitHub endpoints from the environment only together with the test flag, without a trailing slash", () => {
    const config = loadAuthConfig({
      ...validEnv,
      GITHUB_OAUTH_BASE_URL: "http://127.0.0.1:4000/",
      GITHUB_API_BASE_URL: "http://127.0.0.1:4000/",
      ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    });

    expect(config.github.oauthBaseUrl).toBe("http://127.0.0.1:4000");
    expect(config.github.apiBaseUrl).toBe("http://127.0.0.1:4000");
  });

  it.each(["GITHUB_OAUTH_BASE_URL", "GITHUB_API_BASE_URL"])(
    "refuses %s without the test flag, because the client secret would be sent there",
    (name) => {
      const error = loadError({ ...validEnv, [name]: "http://127.0.0.1:4000" });

      expect(error.message).toContain(name);
      expect(error.message).toContain("ALLOW_TEST_GITHUB_ENDPOINTS");
    },
  );

  it("refuses a GitHub endpoint override that is not a URL", () => {
    expect(
      loadError({
        ...validEnv,
        ALLOW_TEST_GITHUB_ENDPOINTS: "true",
        GITHUB_API_BASE_URL: "api.github.com",
      }).message,
    ).toContain("GITHUB_API_BASE_URL");
  });

  it("ignores the test flag when no endpoint is overridden", () => {
    const config = loadAuthConfig({
      ...validEnv,
      ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    });

    expect(config.github.oauthBaseUrl).toBe("https://github.com");
  });

  // CR-18-T13
  it("uses secure cookies exactly when the base URL is https", () => {
    expect(
      loadAuthConfig({
        ...validEnv,
        BETTER_AUTH_URL: "https://reviews.example.com",
      }).secureCookies,
    ).toBe(true);
    expect(loadAuthConfig(validEnv).secureCookies).toBe(false);
    expect(
      loadAuthConfig({ ...validEnv, NODE_ENV: "production" }).secureCookies,
    ).toBe(false);
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3417",
    "http://[::1]:3000",
  ])(
    "starts in production over plain http on the local machine (%s)",
    (url) => {
      expect(() =>
        loadAuthConfig({
          ...validEnv,
          NODE_ENV: "production",
          BETTER_AUTH_URL: url,
        }),
      ).not.toThrow();
    },
  );

  it("refuses production over plain http on another host, where browsers would drop the secure cookies", () => {
    const error = loadError({
      ...validEnv,
      NODE_ENV: "production",
      BETTER_AUTH_URL: "http://reviews.example.com",
    });

    expect(error.message).toContain("BETTER_AUTH_URL");
    expect(error.message).toMatch(/https/);
  });

  it("accepts plain http on another host outside production", () => {
    expect(() =>
      loadAuthConfig({
        ...validEnv,
        BETTER_AUTH_URL: "http://reviews.example.com",
      }),
    ).not.toThrow();
  });
});
