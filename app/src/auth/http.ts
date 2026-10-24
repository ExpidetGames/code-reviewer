// SPDX-License-Identifier: LicenseRef-Proprietary

// What the public HTTP interface of Better Auth is allowed to do. Better Auth ships many endpoints
// (list and revoke sessions, update the user, link accounts, ...) that this app neither needs nor
// wants reachable: some would reveal the session token or let a user rewrite their own profile.
// Only the calls of the sign in are passed on (email with password, and the three of the GitHub sign
// in while that is configured), everything else is a 404.
import type { SignInMethods } from "../admin/sign-in-methods.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import type { Auth } from "./auth.ts";
import type { SignInLimiter, SignInPermission } from "./sign-in-limit.ts";
import { EMAIL_NOT_VERIFIED_CODE } from "./unverified-sign-in.ts";

const AUTH_BASE_PATH = "/api/auth";

type Endpoint = { method: string; path: string };

export const ALLOWED_AUTH_ENDPOINTS: readonly Endpoint[] = [
  // Email and password. The sign-up endpoint is deliberately not here.
  { method: "POST", path: "/sign-in/email" },
  // Starts the sign in and returns the GitHub address to go to.
  { method: "POST", path: "/sign-in/social" },
  // Where GitHub sends the person back to.
  { method: "GET", path: "/callback/github" },
  { method: "POST", path: "/sign-out" },
];

export function isAuthEndpointAllowed(
  method: string,
  pathname: string,
): boolean {
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false;
  const path = pathname.slice(AUTH_BASE_PATH.length);
  return ALLOWED_AUTH_ENDPOINTS.some(
    (endpoint) => endpoint.method === method && endpoint.path === path,
  );
}

const SIGN_IN_EMAIL_PATH = `${AUTH_BASE_PATH}/sign-in/email`;
const GITHUB_PATHS = [
  `${AUTH_BASE_PATH}/sign-in/social`,
  `${AUTH_BASE_PATH}/callback/github`,
];
const SIGN_IN_BODY_MAX_BYTES = 8 * 1024;

/**
 * Whether the request says its body is JSON, and nothing else: the media type is exactly
 * `application/json` (case does not matter, parameters such as a charset are fine). Better Auth
 * reads a sign in body in several formats (JSON, form encoded, multipart, plain text), and an
 * address counted from one format while Better Auth signs in with another would let a guesser pick
 * the key that is counted.
 */
function isJsonSignIn(request: Request): boolean {
  const type = request.headers.get("content-type") ?? "";
  return (type.split(";")[0] ?? "").trim().toLowerCase() === "application/json";
}

/** The email address in the JSON body, as typed; "" when the body is not what a sign in sends. */
function typedEmail(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const email =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { email?: unknown }).email
        : undefined;
    return typeof email === "string" ? email : "";
  } catch {
    return "";
  }
}

const NO_STORE = { "cache-control": "no-store" };

/** Whether Better Auth's answer is the 403 for a right password and an address that is not verified. */
async function isNotVerifiedAnswer(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return body.code === EMAIL_NOT_VERIFIED_CODE;
  } catch {
    return false;
  }
}

/**
 * Passes a request on to Better Auth when it is one of the allowed calls. The sign in with email and
 * password is counted first, with the same shared counters as the login form (sign-in-limit.ts): a
 * refused attempt is answered `429 rate_limited` with `Retry-After` and never reaches Better Auth.
 * Better Auth's own limiter is off (auth.ts) because it keys on a client address that this app cannot
 * trust.
 *
 * For the sign in the body is read exactly once, must be JSON (anything else is `415` and never
 * reaches Better Auth), and Better Auth is handed a new request with exactly the bytes that were
 * counted, so the limiter and Better Auth always see the same email address. Only the body carries
 * the address: Better Auth's sign in reads nothing from the query string or the headers.
 */
export async function handleAuthRequest(
  auth: Pick<Auth, "handler">,
  request: Request,
  limiter: SignInLimiter,
  /**
   * Which ways to sign in are on (the admin portal's setting). A way that is off is refused before it
   * is counted or reaches Better Auth; if the setting cannot be read, no sign in goes through. Left out
   * (tests of other things), both ways are on.
   */
  signInMethods?: () => Promise<SignInMethods>,
  /**
   * The instance of Better Auth that serves the sign in with GitHub (its start and its callback), made for
   * the credentials of the GitHub App in force, or null while there are none. Left out (tests of other
   * things), `auth` serves everything.
   */
  githubAuth?: () => Promise<Pick<Auth, "handler"> | null>,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!isAuthEndpointAllowed(request.method, pathname))
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });

  const isEmail = pathname === SIGN_IN_EMAIL_PATH;
  const isGithub = GITHUB_PATHS.includes(pathname);
  if (signInMethods !== undefined && (isEmail || isGithub)) {
    let methods: SignInMethods;
    try {
      methods = await signInMethods();
    } catch {
      console.error(
        "[auth] SIGN_IN_METHODS_UNAVAILABLE: the setting of the ways to sign in could not be read.",
      );
      return Response.json(
        { error: "sign_in_unavailable" },
        { status: 503, headers: NO_STORE },
      );
    }
    if (isEmail ? !methods.emailPassword : !methods.github) {
      // Somebody coming back from GitHub is in a browser: tell them on the login page. The rest are calls.
      // A relative address: in a route handler the request's own address is the server's (its host
      // name and port), not the one the person used.
      if (pathname.endsWith("/callback/github"))
        return new Response(null, {
          status: 302,
          headers: {
            location: "/login?error=sign_in_method_disabled",
            ...NO_STORE,
          },
        });
      return Response.json(
        { error: "sign_in_method_disabled" },
        { status: 403, headers: NO_STORE },
      );
    }
  }

  if (isGithub && githubAuth !== undefined) {
    let github: Pick<Auth, "handler"> | null;
    try {
      github = await githubAuth();
    } catch {
      console.error(
        "[auth] GITHUB_SIGN_IN_UNAVAILABLE: the credentials of the GitHub sign in could not be read.",
      );
      return Response.json(
        { error: "sign_in_unavailable" },
        { status: 503, headers: NO_STORE },
      );
    }
    if (github === null) {
      if (pathname.endsWith("/callback/github"))
        return new Response(null, {
          status: 302,
          headers: {
            location: "/login?error=github_not_configured",
            ...NO_STORE,
          },
        });
      return Response.json(
        { error: "github_not_configured" },
        { status: 404, headers: NO_STORE },
      );
    }
    return github.handler(request);
  }

  if (!isEmail) return auth.handler(request);

  if (!isJsonSignIn(request))
    return Response.json(
      { error: "unsupported_content_type" },
      { status: 415, headers: NO_STORE },
    );
  const body = await readLimitedBody(request, SIGN_IN_BODY_MAX_BYTES);
  if (!body.ok)
    return Response.json(
      { error: "body_too_large" },
      { status: 413, headers: NO_STORE },
    );
  const email = typedEmail(body.text);
  const forwarded = new Headers(request.headers);
  forwarded.delete("content-length");
  forwarded.delete("transfer-encoding");
  const counted = new Request(request.url, {
    method: request.method,
    headers: forwarded,
    body: body.bytes as BodyInit,
  });

  let permission: SignInPermission;
  try {
    permission = await limiter.check(email);
  } catch {
    console.error(
      "[auth] SIGN_IN_LIMIT_UNAVAILABLE: the sign in attempts could not be counted.",
    );
    return Response.json(
      { error: "sign_in_unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
  if (!permission.allowed)
    return Response.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(permission.retryAfterSeconds),
        },
      },
    );

  const response = await auth.handler(counted);
  // The password was right in two cases: the sign in worked, and the account has to verify its address first
  // (403 EMAIL_NOT_VERIFIED, after the right password). Neither is a failed attempt, so neither counts.
  if (response.ok || (await isNotVerifiedAnswer(response))) {
    try {
      await limiter.succeeded(email);
    } catch {
      console.error(
        "[auth] SIGN_IN_LIMIT_UNAVAILABLE: the sign in attempts could not be reset.",
      );
    }
  }
  return response;
}
