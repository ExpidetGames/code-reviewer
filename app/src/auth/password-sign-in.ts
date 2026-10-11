// The email and password sign in as the login form runs it: the limit first (sign-in-limit.ts), then
// Better Auth, and every outcome sorted into one of four answers the page can translate. Only a 4xx
// answer of Better Auth is "the credentials are not accepted"; anything else (a locked database, a
// broken configuration, an unexpected exception) is the server's problem, logged under its own code
// without the reason (it may quote the request) and shown as "unavailable", never as a wrong password.
import { APIError } from "better-auth/api";
import type { SignInLimiter } from "./sign-in-limit.ts";

export type PasswordSignInOutcome =
  | { kind: "ok" }
  | { kind: "invalid_credentials" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "unavailable" };

export type PasswordSignInDependencies = {
  limiter: SignInLimiter;
  /** Better Auth's sign in; throws when the sign in is not accepted. */
  signIn: (email: string, password: string) => Promise<unknown>;
  log?: (message: string) => void;
};

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
    if (error instanceof APIError) {
      if (error.statusCode === 429)
        return { kind: "rate_limited", retryAfterSeconds: 60 };
      if (error.statusCode >= 400 && error.statusCode < 500)
        return { kind: "invalid_credentials" };
    }
    log(
      "[auth] SIGN_IN_SERVER_ERROR: the sign in failed on the server, not because of the credentials.",
    );
    return { kind: "unavailable" };
  }

  try {
    await limiter.succeeded(email);
  } catch {
    log(
      "[auth] SIGN_IN_LIMIT_UNAVAILABLE: the sign in attempts could not be reset.",
    );
  }
  return { kind: "ok" };
}
