// SPDX-License-Identifier: LicenseRef-Proprietary

// The limits on the endpoints that can be guessed or made to send mail: sign-up, the mail that carries
// a verification link, and the use of a link. Counted in the shared `rate_limits` table (docs/decisions/
// 0001-editions-setup-and-accounts.md, section 2.10), so every app instance counts the same attempts.
//
// - Sign-up: per address (10 per hour) and for the whole instance (60 per minute). Counted whether or
//   not the address exists or is allowed, and before anything is looked up, so a refusal by the limit
//   looks the same for every address.
// - Mail: per address (5 per hour) and for the whole instance (200 per 10 minutes). Every path that
//   sends a verification link counts here, a sign-up and a resend alike, so the two cannot be added up
//   against one inbox. Counted before the account is looked up: an unknown address is refused exactly
//   when a known one is.
// - The reset mail (`password-reset-request.ts`): per address (5 per hour, counted before the account is
//   looked up, so an unknown address is refused exactly when a known one is) and for the whole instance
//   (200 per 10 minutes, counted only for a mail that is really about to be sent).
// - A link: per link that exists (10 attempts in the 24 hours it lives), like the password reset
//   (`src/auth/password-reset-http.ts`). A token that does not exist touches no counter, and there is
//   no counter for all links together, so junk requests can never use up the attempts of a person's
//   valid link; the token has 256 random bits, so there is nothing to guess anyway.
//
// A limit by address alone could be avoided by changing the address, and a limit for the whole instance
// alone would let one address use it up, so the sign-up and the mail have both. The address counter is
// asked first: attempts beyond it do not use up the instance counter. The key is a hash of the canonical
// address (`canonicalEmail`), so every spelling of an address is one counter, and no address is stored.
// It is not keyed by client address: that is only as trustworthy as the proxy in front of the app.
import { createHash } from "node:crypto";
import { secondsLeft, type SignInPermission } from "../auth/sign-in-limit.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { VERIFICATION_TOKEN_TTL_MS } from "./verification-tokens.ts";

export const SIGN_UP_ADDRESS_MAX = 10;
export const SIGN_UP_ADDRESS_WINDOW_MS = 60 * 60 * 1000;
export const SIGN_UP_GLOBAL_MAX = 60;
export const SIGN_UP_GLOBAL_WINDOW_MS = 60 * 1000;

export const VERIFICATION_MAIL_ADDRESS_MAX = 5;
export const VERIFICATION_MAIL_ADDRESS_WINDOW_MS = 60 * 60 * 1000;
export const VERIFICATION_MAIL_GLOBAL_MAX = 200;
export const VERIFICATION_MAIL_GLOBAL_WINDOW_MS = 10 * 60 * 1000;

// The mail that carries a password reset link. A request is counted per address before anything is looked
// up (the same for an address with an account and one without); the instance counter is only touched by a
// mail that is really about to go out, so requests for addresses that have no account can never use it up
// and keep a real reset from being mailed.
export const PASSWORD_RESET_REQUEST_ADDRESS_MAX = 5;
export const PASSWORD_RESET_REQUEST_ADDRESS_WINDOW_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_MAIL_GLOBAL_MAX = 200;
export const PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS = 10 * 60 * 1000;

export const VERIFY_TOKEN_MAX_ATTEMPTS = 10;
export const VERIFY_TOKEN_WINDOW_MS = VERIFICATION_TOKEN_TTL_MS;

export type Permission = SignInPermission;

export type SignUpLimits = {
  /** Counts one sign-up attempt for this canonical address. */
  signUp(email: string): Promise<Permission>;
  /** Counts one verification mail to this canonical address. */
  mail(email: string): Promise<Permission>;
  /** Counts one request for a password reset mail to this canonical address, whether it has an account or not. */
  resetRequest(email: string): Promise<Permission>;
  /** Counts one reset mail that is about to be sent (an account exists), for the whole instance. */
  resetMail(): Promise<Permission>;
  /** Counts one attempt against a link that exists; `tokenHash` is the hash of its token. */
  verifyToken(tokenHash: string): Promise<Permission>;
};

function addressHash(email: string): string {
  return createHash("sha256").update(email, "utf8").digest("hex");
}

export function signUpAddressKey(email: string): string {
  return `sign-up:email:${addressHash(email)}`;
}
export function verificationMailAddressKey(email: string): string {
  return `verification-mail:email:${addressHash(email)}`;
}
export function verifyTokenKey(tokenHash: string): string {
  return `verify-email:${tokenHash}`;
}
export function passwordResetRequestKey(email: string): string {
  return `password-reset-request:email:${addressHash(email)}`;
}
export const PASSWORD_RESET_MAIL_GLOBAL_KEY = "password-reset-mail:all";
export const SIGN_UP_GLOBAL_KEY = "sign-up:all";
export const VERIFICATION_MAIL_GLOBAL_KEY = "verification-mail:all";

export function createSignUpLimits(
  rateLimits: RateLimitsRepository,
  now: () => Date = () => new Date(),
): SignUpLimits {
  async function counted(
    first: { key: string; max: number; windowMs: number },
    second: { key: string; max: number; windowMs: number },
  ): Promise<Permission> {
    for (const { key, max, windowMs } of [first, second]) {
      const hit = await rateLimits.hit(key, windowMs);
      if (hit.count > max)
        return {
          allowed: false,
          retryAfterSeconds: secondsLeft(hit.windowStartedAt, windowMs, now()),
        };
    }
    return { allowed: true };
  }

  async function single(
    key: string,
    max: number,
    windowMs: number,
  ): Promise<Permission> {
    const hit = await rateLimits.hit(key, windowMs);
    return hit.count > max
      ? {
          allowed: false,
          retryAfterSeconds: secondsLeft(hit.windowStartedAt, windowMs, now()),
        }
      : { allowed: true };
  }

  return {
    resetRequest: (email) =>
      single(
        passwordResetRequestKey(email),
        PASSWORD_RESET_REQUEST_ADDRESS_MAX,
        PASSWORD_RESET_REQUEST_ADDRESS_WINDOW_MS,
      ),
    resetMail: () =>
      single(
        PASSWORD_RESET_MAIL_GLOBAL_KEY,
        PASSWORD_RESET_MAIL_GLOBAL_MAX,
        PASSWORD_RESET_MAIL_GLOBAL_WINDOW_MS,
      ),
    signUp: (email) =>
      counted(
        {
          key: signUpAddressKey(email),
          max: SIGN_UP_ADDRESS_MAX,
          windowMs: SIGN_UP_ADDRESS_WINDOW_MS,
        },
        {
          key: SIGN_UP_GLOBAL_KEY,
          max: SIGN_UP_GLOBAL_MAX,
          windowMs: SIGN_UP_GLOBAL_WINDOW_MS,
        },
      ),
    mail: (email) =>
      counted(
        {
          key: verificationMailAddressKey(email),
          max: VERIFICATION_MAIL_ADDRESS_MAX,
          windowMs: VERIFICATION_MAIL_ADDRESS_WINDOW_MS,
        },
        {
          key: VERIFICATION_MAIL_GLOBAL_KEY,
          max: VERIFICATION_MAIL_GLOBAL_MAX,
          windowMs: VERIFICATION_MAIL_GLOBAL_WINDOW_MS,
        },
      ),
    async verifyToken(tokenHash) {
      const hit = await rateLimits.hit(
        verifyTokenKey(tokenHash),
        VERIFY_TOKEN_WINDOW_MS,
      );
      return hit.count > VERIFY_TOKEN_MAX_ATTEMPTS
        ? {
            allowed: false,
            retryAfterSeconds: secondsLeft(
              hit.windowStartedAt,
              VERIFY_TOKEN_WINDOW_MS,
              now(),
            ),
          }
        : { allowed: true };
    },
  };
}
