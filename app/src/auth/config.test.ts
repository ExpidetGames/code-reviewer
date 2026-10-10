// Pins down how the sign-in settings are read from the environment: what is required, what a
// missing value reports, which defaults point at the real GitHub, and that no secret is ever echoed.
import { describe, expect, it } from "vitest";
import { AuthConfigError, loadAuthConfig } from "./config.ts";

const SECRET = "s".repeat(40);
const CLIENT_SECRET = "dummy-client-secret-value";
const validEnv = {
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_OAUTH_CLIENT_ID: "dummy-client-id",
  GITHUB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
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
  it("reads the four required values and points GitHub at the real endpoints by default", () => {
    const config = loadAuthConfig(validEnv);

    expect(config).toMatchObject({
      secret: SECRET,
      baseUrl: "http://localhost:3000",
      github: {
        clientId: "dummy-client-id",
        clientSecret: CLIENT_SECRET,
        oauthBaseUrl: "https://github.com",
        apiBaseUrl: "https://api.github.com",
      },
    });
  });

  it("names every missing variable at once, never a value", () => {
    const error = loadError({ BETTER_AUTH_SECRET: SECRET });

    expect(error.code).toBe("AUTH_CONFIG_INVALID");
    expect(error.message).toContain("BETTER_AUTH_URL");
    expect(error.message).toContain("GITHUB_OAUTH_CLIENT_ID");
    expect(error.message).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(error.message).not.toContain(SECRET);
  });

  it("treats blank values as missing", () => {
    const error = loadError({ ...validEnv, GITHUB_OAUTH_CLIENT_ID: "   " });

    expect(error.message).toContain("GITHUB_OAUTH_CLIENT_ID");
  });

  it("rejects a signing secret that is too short without echoing it", () => {
    const error = loadError({ ...validEnv, BETTER_AUTH_SECRET: "short" });

    expect(error.message).toContain("BETTER_AUTH_SECRET");
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

  it("takes the GitHub endpoints from the environment when they are set, without a trailing slash", () => {
    const config = loadAuthConfig({
      ...validEnv,
      GITHUB_OAUTH_BASE_URL: "http://127.0.0.1:4000/",
      GITHUB_API_BASE: "http://127.0.0.1:4000/",
    });

    expect(config.github.oauthBaseUrl).toBe("http://127.0.0.1:4000");
    expect(config.github.apiBaseUrl).toBe("http://127.0.0.1:4000");
  });

  it("rejects a GitHub endpoint override that is not a URL", () => {
    expect(
      loadError({ ...validEnv, GITHUB_API_BASE: "api.github.com" }).message,
    ).toContain("GITHUB_API_BASE");
  });

  it("uses secure cookies in production and for an https address, plain cookies otherwise", () => {
    expect(
      loadAuthConfig({ ...validEnv, NODE_ENV: "production" }).secureCookies,
    ).toBe(true);
    expect(
      loadAuthConfig({
        ...validEnv,
        BETTER_AUTH_URL: "https://reviews.example.com",
      }).secureCookies,
    ).toBe(true);
    expect(
      loadAuthConfig({ ...validEnv, NODE_ENV: "development" }).secureCookies,
    ).toBe(false);
  });
});
