// Reads the sign-in settings from the environment. The only place that knows the variable names.
// A problem is reported with the variable names only, never with a value (they include secrets).

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
   * Signs the session cookie and encrypts the stored GitHub access token. Rotating it signs
   * everybody out and makes the stored tokens unreadable (they are replaced at the next sign in).
   */
  secret: string;
  /** Origin of this app as users reach it; the GitHub OAuth callback is `<baseUrl>/api/auth/callback/github`. */
  baseUrl: string;
  github: {
    clientId: string;
    clientSecret: string;
    /** Authorize and token endpoints live below this URL (`/login/oauth/...`). */
    oauthBaseUrl: string;
    /** `/user` and `/user/emails` live below this URL. */
    apiBaseUrl: string;
  };
  /** Whether the cookies get the `Secure` attribute: exactly when `BETTER_AUTH_URL` is https. */
  secureCookies: boolean;
};

export const DEFAULT_GITHUB_OAUTH_BASE_URL = "https://github.com";
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

const MIN_SECRET_LENGTH = 32;

type Env = Readonly<Record<string, string | undefined>>;

export function loadAuthConfig(env: Env): AuthConfig {
  const problems: string[] = [];

  const secret = required(env, "BETTER_AUTH_SECRET", problems);
  if (secret !== undefined && secret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters long`,
    );
  }
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
  const allowTestEndpoints = env.ALLOW_TEST_GITHUB_ENDPOINTS === "true";
  const clientId = required(env, "GITHUB_OAUTH_CLIENT_ID", problems);
  const clientSecret = required(env, "GITHUB_OAUTH_CLIENT_SECRET", problems);
  const oauthBaseUrl = optionalBaseUrl(
    env,
    "GITHUB_OAUTH_BASE_URL",
    DEFAULT_GITHUB_OAUTH_BASE_URL,
    allowTestEndpoints,
    problems,
  );
  const apiBaseUrl = optionalBaseUrl(
    env,
    "GITHUB_API_BASE",
    DEFAULT_GITHUB_API_BASE_URL,
    allowTestEndpoints,
    problems,
  );

  if (
    problems.length > 0 ||
    secret === undefined ||
    baseUrl === undefined ||
    clientId === undefined ||
    clientSecret === undefined
  ) {
    throw new AuthConfigError(
      `The sign-in configuration is incomplete or invalid: ${problems.join("; ")}.`,
    );
  }

  return {
    secret,
    baseUrl,
    github: { clientId, clientSecret, oauthBaseUrl, apiBaseUrl },
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

// The GitHub endpoints default to the real GitHub. The token exchange sends the client secret and
// the authorization code to whatever they name, so an override is only accepted together with
// ALLOW_TEST_GITHUB_ENDPOINTS=true, which only the test stack sets (it points the sign in at
// fakes/github).
function optionalBaseUrl(
  env: Env,
  name: string,
  fallback: string,
  allowed: boolean,
  problems: string[],
): string {
  const value = env[name]?.trim();
  if (!value) return fallback;
  if (!allowed) {
    problems.push(
      `${name} may only be set together with ALLOW_TEST_GITHUB_ENDPOINTS=true (test stack only); unset it to use the real GitHub`,
    );
    return fallback;
  }
  const url = parseHttpUrl(value);
  if (!url) {
    problems.push(`${name} must be an http or https URL`);
    return fallback;
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}
