// SPDX-License-Identifier: Apache-2.0

// Reads the sign-in settings from the environment. The only place that knows the variable names.
// A problem is reported with the variable names only, never with a value (they include secrets).
// The credentials of the sign in with GitHub (the GitHub App's client id and secret) are not here: they
// live in the database and the admin portal edits them (src/github-config/).
import {
  ALLOW_TEST_GITHUB_ENDPOINTS_FLAG,
  resolveGithubEndpoint,
  testGithubEndpointsAllowed,
} from "../github-endpoints.ts";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { parseAccessConfig, type AccessConfig } from "./access-config.ts";

export const AUTH_ERROR_CODES = ["AUTH_CONFIG_INVALID"] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export class AuthConfigError extends Error {
  readonly code: AuthErrorCode = "AUTH_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export type AuthConfig = {
  /**
   * The master key of the instance: `APP_SECRET`, or `BETTER_AUTH_SECRET` (its deprecated name) when
   * that is not set. Signs the session cookie and encrypts the stored GitHub access token. Rotating
   * it signs everybody out and makes the stored tokens unreadable (they are replaced at the next
   * sign in).
   */
  secret: string;
  /** Origin of this app as users reach it; the callback of the GitHub sign in is `<baseUrl>/api/auth/callback/github`. */
  baseUrl: string;
  github: {
    /** Authorize and token endpoints live below this URL (`/login/oauth/...`). */
    oauthBaseUrl: string;
    /** `/user` and `/user/emails` live below this URL. */
    apiBaseUrl: string;
  };
  /**
   * The allow list of the earlier sign in (`ALLOWED_GITHUB_LOGINS`, `ALLOWED_GITHUB_ORG`). Nothing enforces it any
   * more; the import of an existing installation reads it once.
   */
  access: AccessConfig;
  /** Whether the cookies get the `Secure` attribute: exactly when `BETTER_AUTH_URL` is https. */
  secureCookies: boolean;
};

export const DEFAULT_GITHUB_OAUTH_BASE_URL = "https://github.com";
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

type Env = Readonly<Record<string, string | undefined>>;

export function loadAuthConfig(env: Env): AuthConfig {
  const problems: string[] = [];

  const resolvedSecret = resolveAppSecret(env);
  if (!resolvedSecret.ok) problems.push(resolvedSecret.problem);
  const secret = resolvedSecret.ok ? resolvedSecret.secret : undefined;
  const baseUrl = originOf(
    required(env, "BETTER_AUTH_URL", problems),
    "BETTER_AUTH_URL",
    problems,
  );
  // Over plain http browsers drop `Secure` cookies, so a production instance on http could never
  // keep a sign in going (it would loop with state_mismatch). Say so at the start instead.
  if (
    baseUrl !== undefined &&
    env.NODE_ENV === "production" &&
    baseUrl.startsWith("http://") &&
    !isLoopbackHost(new URL(baseUrl).hostname)
  ) {
    problems.push(
      "BETTER_AUTH_URL must be an https address in production (plain http is only accepted for localhost)",
    );
  }
  const allowTestEndpoints = testGithubEndpointsAllowed(env);
  const oauthBaseUrl = optionalBaseUrl(
    env,
    "GITHUB_OAUTH_BASE_URL",
    DEFAULT_GITHUB_OAUTH_BASE_URL,
    allowTestEndpoints,
    problems,
  );
  const apiBaseUrl = optionalBaseUrl(
    env,
    "GITHUB_API_BASE_URL",
    DEFAULT_GITHUB_API_BASE_URL,
    allowTestEndpoints,
    problems,
  );

  // The allow list no longer decides anything (the sign-up rule and the workspaces do); the import of an existing
  // installation reads it once (src/legacy-import/). A value that cannot be read is not a reason to stop the
  // start, so its problems go nowhere.
  const access = parseAccessConfig(env, []);

  if (problems.length > 0 || secret === undefined || baseUrl === undefined) {
    throw new AuthConfigError(
      `The sign-in configuration is incomplete or invalid: ${problems.join("; ")}.`,
    );
  }

  return {
    secret,
    baseUrl,
    github: {
      oauthBaseUrl,
      apiBaseUrl,
    },
    access,
    secureCookies: baseUrl.startsWith("https://"),
  };
}

function required(
  env: Env,
  name: string,
  problems: string[],
): string | undefined {
  const value = env[name]?.trim();
  if (value) return value;
  problems.push(`${name} is not set`);
  return undefined;
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function originOf(
  value: string | undefined,
  name: string,
  problems: string[],
): string | undefined {
  if (value === undefined) return undefined;
  const url = parseHttpUrl(value);
  if (url) return url.origin;
  problems.push(`${name} must be an http or https URL`);
  return undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

// The rule for the GitHub addresses is shared with the GitHub App settings (src/github-endpoints.ts).
function optionalBaseUrl(
  env: Env,
  name: string,
  fallback: string,
  allowed: boolean,
  problems: string[],
): string {
  const endpoint = resolveGithubEndpoint(env[name], fallback, allowed);
  if (endpoint.ok) return endpoint.url;
  problems.push(
    endpoint.problem === "invalid"
      ? `${name} must be an http or https URL`
      : `${name} may only be set together with ${ALLOW_TEST_GITHUB_ENDPOINTS_FLAG}=true (test stack only); unset it to use the real GitHub`,
  );
  return fallback;
}
