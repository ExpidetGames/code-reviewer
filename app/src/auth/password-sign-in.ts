// SPDX-License-Identifier: LicenseRef-Proprietary

// The email and password sign in as the login form runs it: the limit first (sign-in-limit.ts), then
// Better Auth, and every outcome sorted into one of four answers the page can translate. Only a 4xx
// answer of Better Auth is "the credentials are not accepted"; anything else (a locked database, a
// broken configuration, an unexpected exception) is the server's problem, logged under its own code
// without the reason (it may quote the request) and shown as "unavailable", never as a wrong password.
import type { SignInLimiter } from "./sign-in-limit.ts";
import { EMAIL_NOT_VERIFIED_CODE } from "./unverified-sign-in.ts";

/**
 * The HTTP status of an error that Better Auth threw on purpose, or null for anything else. Read by
 * shape, not with `instanceof APIError`: in the built server the class that Better Auth throws and the
 * one this module could import are not always the same copy, and `instanceof` then fails silently
 * (a wrong password would be reported as a server error).
 */
export function apiErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const { name, statusCode } = error as {
    name?: unknown;
    statusCode?: unknown;
  };
  return name === "APIError" && typeof statusCode === "number"
    ? statusCode
    : null;
}

/** The `code` Better Auth gave the error it threw on purpose, or null. */
function apiErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { body } = error as { body?: { code?: unknown } };
  return typeof body?.code === "string" ? body.code : null;
}

export type PasswordSignInOutcome =
  | { kind: "ok" }
  | { kind: "invalid_credentials" }
  /** The password was right, and the address must be verified before the account signs in. */
  | { kind: "email_not_verified" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "unavailable" };

export type PasswordSignInDependencies = {
  limiter: SignInLimiter;
  /** Better Auth's sign in; throws when the sign in is not accepted. */
  signIn: (email: string, password: string) => Promise<unknown>;
  log?: (message: string) => void;
};

async function resetCounter(
  limiter: SignInLimiter,
  email: string,
  log: (message: string) => void,
): Promise<void> {
  try {
    await limiter.succeeded(email);
  } catch {
    log(
      "[auth] SIGN_IN_LIMIT_UNAVAILABLE: the sign in attempts could not be reset.",
    );
  }
}

export async function signInWithPasswordChecked(
  { limiter, signIn, log = console.error }: PasswordSignInDependencies,
  email: string,
  password: string,
): Promise<PasswordSignInOutcome> {
  try {
    const permission = await limiter.check(email);
    if (!permission.allowed)
      return {
        kind: "rate_limited",
        retryAfterSeconds: permission.retryAfterSeconds,
      };
  } catch {
    // No answer from the counters is a no, not a free pass.
    log(
      "[auth] SIGN_IN_LIMIT_UNAVAILABLE: the sign in attempts could not be counted.",
    );
    return { kind: "unavailable" };
  }

  try {
    await signIn(email, password);
  } catch (error) {
    const status = apiErrorStatus(error);
    if (status === 429) return { kind: "rate_limited", retryAfterSeconds: 60 };
    if (status === 403 && apiErrorCode(error) === EMAIL_NOT_VERIFIED_CODE) {
      // The password was right: not a failed attempt, so the counter of the account starts again.
      await resetCounter(limiter, email, log);
      return { kind: "email_not_verified" };
    }
    if (status !== null && status >= 400 && status < 500)
      return { kind: "invalid_credentials" };
    log(
      "[auth] SIGN_IN_SERVER_ERROR: the sign in failed on the server, not because of the credentials.",
    );
    return { kind: "unavailable" };
  }

  await resetCounter(limiter, email, log);
  return { kind: "ok" };
}
