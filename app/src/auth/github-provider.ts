// The GitHub OAuth app as a Better Auth provider. Better Auth's built-in GitHub provider has the
// GitHub URLs hard-coded, so the sign in could never be pointed at the fake GitHub in tests. This
// provider is the generic OAuth one with GitHub's three endpoints made configurable; everything
// else (state, PKCE, session, account linking) is still Better Auth's.
//
// Nothing here logs or puts into an error message a token, the client secret or the authorization
// code: Better Auth logs the errors thrown from here.
import type { OAuth2Tokens } from "better-auth/oauth2";
import type {
  GenericOAuthConfig,
  GenericOAuthUserInfo,
} from "better-auth/plugins/generic-oauth";

export const GITHUB_PROVIDER_ID = "github";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const SCOPES = ["read:user", "user:email"];

export type GithubProviderOptions = {
  clientId: string;
  clientSecret: string;
  /** Base URL of `/login/oauth/authorize` and `/login/oauth/access_token`. */
  oauthBaseUrl: string;
  /** Base URL of `/user` and `/user/emails`. */
  apiBaseUrl: string;
  /** How long a call to GitHub may take before the sign in fails. */
  requestTimeoutMs?: number;
};

type GithubProfile = {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
};

type GithubEmail = { email: string; primary: boolean; verified: boolean };

export function githubProviderConfig(
  options: GithubProviderOptions,
): GenericOAuthConfig<typeof GITHUB_PROVIDER_ID> {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    providerId: GITHUB_PROVIDER_ID,
    name: "GitHub",
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authorizationUrl: `${options.oauthBaseUrl}/login/oauth/authorize`,
    tokenUrl: `${options.oauthBaseUrl}/login/oauth/access_token`,
    scopes: SCOPES,
    pkce: true,
    // The person keeps one user row for the life of the GitHub account: name, avatar and login
    // follow what GitHub says at every sign in.
    overrideUserInfo: true,
    getToken: ({ code, redirectURI, codeVerifier }) =>
      exchangeCode(options, timeoutMs, { code, redirectURI, codeVerifier }),
    getUserInfo: (tokens) => readProfile(options, timeoutMs, tokens),
    mapProfileToUser: (profile) => ({
      githubLogin: typeof profile.login === "string" ? profile.login : "",
    }),
  };
}

async function exchangeCode(
  options: GithubProviderOptions,
  timeoutMs: number,
  grant: { code: string; redirectURI: string; codeVerifier?: string },
): Promise<OAuth2Tokens> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    code: grant.code,
    redirect_uri: grant.redirectURI,
  });
  if (grant.codeVerifier) body.set("code_verifier", grant.codeVerifier);

  const response = await fetch(
    `${options.oauthBaseUrl}/login/oauth/access_token`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok)
    throw new Error(
      `GitHub's token endpoint answered with status ${String(response.status)}`,
    );

  const data = (await response.json()) as {
    access_token?: unknown;
    token_type?: unknown;
    scope?: unknown;
    error?: unknown;
  };
  // GitHub answers a refused code with status 200 and an `error` field.
  if (typeof data.access_token !== "string" || data.access_token === "")
    throw new Error(
      `GitHub did not issue an access token (${typeof data.error === "string" ? data.error : "no error given"})`,
    );
  return {
    accessToken: data.access_token,
    tokenType: typeof data.token_type === "string" ? data.token_type : "bearer",
    scopes:
      typeof data.scope === "string"
        ? data.scope.split(/[ ,]+/).filter(Boolean)
        : [],
  };
}

async function readProfile(
  options: GithubProviderOptions,
  timeoutMs: number,
  tokens: OAuth2Tokens,
): Promise<GenericOAuthUserInfo | null> {
  if (!tokens.accessToken) return null;

  const profile = await getJson<GithubProfile>(
    `${options.apiBaseUrl}/user`,
    tokens.accessToken,
    timeoutMs,
  );
  if (!profile || typeof profile.id !== "number" || !profile.login) return null;

  // `/user` leaves `email` empty when the person keeps the address private; the list has it, and
  // says which addresses are verified.
  const emails = await getJson<GithubEmail[]>(
    `${options.apiBaseUrl}/user/emails`,
    tokens.accessToken,
    timeoutMs,
  );
  const chosen = chooseEmail(profile, Array.isArray(emails) ? emails : []);

  return {
    id: String(profile.id),
    login: profile.login,
    name: profile.name || profile.login,
    email: chosen.email,
    emailVerified: chosen.verified,
    image: profile.avatar_url ?? undefined,
  };
}

/**
 * The address stored on the user. Better Auth needs one, and a GitHub account may expose none (the
 * email is hidden and the token cannot read the list). The stand-in is GitHub's own noreply address
 * for that account id: it never changes when the login does, and it is marked unverified.
 */
export function chooseEmail(
  profile: Pick<GithubProfile, "id" | "email">,
  emails: GithubEmail[],
): { email: string; verified: boolean } {
  const publicEmail = profile.email?.trim();
  if (publicEmail) {
    const listed = emails.find(
      (entry) => entry.email.toLowerCase() === publicEmail.toLowerCase(),
    );
    return { email: publicEmail, verified: listed?.verified ?? false };
  }
  const best =
    emails.find((entry) => entry.primary && entry.verified) ??
    emails.find((entry) => entry.verified) ??
    emails.find((entry) => entry.primary) ??
    emails[0];
  if (best) return { email: best.email, verified: best.verified };
  return { email: noreplyEmail(profile.id), verified: false };
}

export function noreplyEmail(githubId: number): string {
  return `${String(githubId)}@users.noreply.github.com`;
}

async function getJson<T>(
  url: string,
  accessToken: string,
  timeoutMs: number,
): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "code-reviewer",
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
