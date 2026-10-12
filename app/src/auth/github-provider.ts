// SPDX-License-Identifier: Apache-2.0

// The GitHub App's user authorization as a Better Auth provider (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.4): "Sign in with GitHub" is the user authorization of the same GitHub App that
// reviews the pull requests. Better Auth's built-in GitHub provider has the GitHub URLs hard-coded, so
// the sign in could never be pointed at the fake GitHub in tests. This provider is the generic OAuth one
// with GitHub's endpoints made configurable; everything else (state, PKCE, session, account linking) is
// still Better Auth's.
//
// A GitHub App ignores scopes: what the user token may read is what the App is granted (the account
// permission "Email addresses" lets it read `GET /user/emails`). The provider reads the profile and the
// email addresses of the person, hands them to the sign in decision (src/github-signin/decide.ts), and
// returns who the person is for Better Auth, or a refusal that `user.validateUserInfo` in auth.ts turns
// into the login page's `?error=` code before any user, account or session is written.
//
// Nothing here logs or puts into an error message a token, the client secret or the authorization
// code: Better Auth logs the errors thrown from here.
import type { OAuth2Tokens } from "better-auth/oauth2";
import type {
  GenericOAuthConfig,
  GenericOAuthUserInfo,
} from "better-auth/plugins/generic-oauth";
import {
  isGithubSignInRefusal,
  type GithubSignInDecision,
  type GithubSignInRefusal,
} from "../github-signin/decide.ts";
import type { GithubEmail } from "../signup/github.ts";

export const GITHUB_PROVIDER_ID = "github";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type GithubProviderOptions = {
  clientId: string;
  clientSecret: string;
  /** Base URL of `/login/oauth/authorize` and `/login/oauth/access_token`. */
  oauthBaseUrl: string;
  /** Base URL of `/user` and `/user/emails`. */
  apiBaseUrl: string;
  /** How long a call to GitHub may take before the sign in fails. */
  requestTimeoutMs?: number;
  /**
   * Decides who the person is from the GitHub account and its email addresses. Required: a provider
   * without a decision would let everybody in. The decision is attached to the profile;
   * `user.validateUserInfo` in auth.ts refuses the sign in before anything is written.
   */
  decide: (input: {
    /** The numeric GitHub id of the account, as text. */
    githubId: string;
    login: string;
    /** What `GET /user/emails` said; null when it could not be read. */
    emails: readonly GithubEmail[] | null;
  }) => Promise<GithubSignInDecision>;
};

export type GithubProfile = {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
};

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
    // A GitHub App ignores scopes.
    scopes: [],
    pkce: true,
    // The person keeps one user row for the life of the GitHub account: name, avatar and login
    // follow what GitHub says at every sign in.
    overrideUserInfo: true,
    getToken: ({ code, redirectURI, codeVerifier }) =>
      exchangeCode(options, timeoutMs, { code, redirectURI, codeVerifier }),
    getUserInfo: (tokens) => readProfile(options, timeoutMs, tokens),
    mapProfileToUser: (profile) => ({
      githubLogin: typeof profile.login === "string" ? profile.login : "",
      // The address another account has, for a placeholder that could not be replaced; null clears it.
      emailConflict: conflictOf(readDecision(profile)),
    }),
  };
}

/** The address and the credentials of the App's user authorization. */
export type GithubAuthorizationEndpoint = {
  clientId: string;
  clientSecret: string;
  /** Base URL of `/login/oauth/authorize` and `/login/oauth/access_token`. */
  oauthBaseUrl: string;
};

/**
 * Trades an authorization code (with the PKCE verifier of the request, when there was one) for the user
 * token of the App. Used by the sign in (through Better Auth) and by the linking of a GitHub identity
 * (src/github-signin/link.ts). Throws with a message that names the status or GitHub's error code, never
 * the code, the client secret or a token.
 */
export async function exchangeCode(
  options: GithubAuthorizationEndpoint,
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
  const emails = await readEmails(
    options.apiBaseUrl,
    tokens.accessToken,
    timeoutMs,
  );

  const decision = await options.decide({
    githubId: String(profile.id),
    login: profile.login,
    emails,
  });

  return {
    id: String(profile.id),
    login: profile.login,
    codeReviewerSignIn: decision,
    name: profile.name || profile.login,
    // Better Auth needs an address; a refused sign in never gets as far as using this one.
    email: decision.allowed ? decision.email : noreplyEmail(profile.id),
    emailVerified: decision.allowed ? decision.emailVerified : false,
    image: profile.avatar_url ?? undefined,
  };
}

/**
 * Reads the decision back out of the profile that the provider returned. Anything that is not exactly a
 * decision (missing, wrong shape) is a refusal.
 */
export function readSignInDecision(
  profile: Record<string, unknown> | undefined,
): { allowed: true } | { allowed: false; reason: GithubSignInRefusal } {
  const decision = readDecision(profile);
  if (decision === null) return { allowed: false, reason: "check_failed" };
  if (decision.allowed) return { allowed: true };
  return {
    allowed: false,
    reason: isGithubSignInRefusal(decision.reason)
      ? decision.reason
      : "check_failed",
  };
}

function conflictOf(decision: GithubSignInDecision | null): string | null {
  return decision?.allowed === true ? decision.emailConflict : null;
}

function readDecision(
  profile: Record<string, unknown> | undefined,
): GithubSignInDecision | null {
  const decision = profile?.codeReviewerSignIn;
  if (typeof decision !== "object" || decision === null) return null;
  const { allowed } = decision as { allowed?: unknown };
  if (allowed === true || allowed === false)
    return decision as GithubSignInDecision;
  return null;
}

/**
 * The placeholder address of a GitHub account: `<github id>@users.noreply.github.com`, the address of the
 * previous sign in, which never read the real one. Only an imported user still has it, and a refused
 * sign in carries it because Better Auth wants an address.
 */
export function noreplyEmail(githubId: number): string {
  return `${String(githubId)}@users.noreply.github.com`;
}

async function readEmails(
  apiBaseUrl: string,
  accessToken: string,
  timeoutMs: number,
): Promise<GithubEmail[] | null> {
  const list = await getJson<unknown>(
    `${apiBaseUrl}/user/emails`,
    accessToken,
    timeoutMs,
  );
  if (!Array.isArray(list)) return null;
  const emails: GithubEmail[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) return null;
    const { email, primary, verified } = entry as Record<string, unknown>;
    if (
      typeof email !== "string" ||
      typeof primary !== "boolean" ||
      typeof verified !== "boolean"
    )
      return null;
    emails.push({ email, primary, verified });
  }
  return emails;
}

export async function getJson<T>(
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
