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
  /** Signs the session cookie and encrypts the stored GitHub tokens. */
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
  /** Whether the session cookie gets the `Secure` attribute. */
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
  const clientId = required(env, "GITHUB_OAUTH_CLIENT_ID", problems);
  const clientSecret = required(env, "GITHUB_OAUTH_CLIENT_SECRET", problems);
  const oauthBaseUrl = optionalBaseUrl(
    env,
    "GITHUB_OAUTH_BASE_URL",
    DEFAULT_GITHUB_OAUTH_BASE_URL,
    problems,
  );
  const apiBaseUrl = optionalBaseUrl(
    env,
    "GITHUB_API_BASE",
    DEFAULT_GITHUB_API_BASE_URL,
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
    secureCookies:
      env.NODE_ENV === "production" || baseUrl.startsWith("https://"),
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

// The GitHub endpoints default to the real GitHub. Overriding them points the whole sign in at
// another server and exists for the test stack only (fakes/github); never set it in production.
function optionalBaseUrl(
  env: Env,
  name: string,
  fallback: string,
  problems: string[],
): string {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const url = parseHttpUrl(value);
  if (!url) {
    problems.push(`${name} must be an http or https URL`);
    return fallback;
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}
