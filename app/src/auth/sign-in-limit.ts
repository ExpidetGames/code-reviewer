// SPDX-License-Identifier: Apache-2.0

// The limit on email and password sign in attempts, counted in the shared `rate_limits` table
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.10), so every app instance counts the
// same attempts. Two counters:
//
// - per account: about 5 attempts per 15 minutes for one email address, key `sign-in:email:<sha256 of
//   the normalized address>`. The key is made from what was typed, never from whether an account
//   exists, so an unknown address is counted, delayed and refused exactly like a known one and
//   nothing reveals which accounts exist. A successful sign in forgets the counter.
// - instance wide: a generous 100 attempts per minute in total, to bound how much guessing the whole
//   instance can be subjected to.
//
// It is not keyed by client address: a client address is only as trustworthy as the proxy in front of
// the app, and a spoofable key would let a guesser start again with every request. The price is that
// someone can keep an account locked for 15 minutes by guessing against it; the admin recovers by
// waiting, and `admin reset-password` (a later issue) does not depend on this counter.
//
// Both the login form (a Server Function, `password-sign-in.ts`) and the HTTP endpoint
// (`http.ts`) go through here: Better Auth's own limiter only sees the HTTP router, not a direct
// `api` call.
import { createHash } from "node:crypto";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";

export const SIGN_IN_ACCOUNT_MAX_ATTEMPTS = 5;
export const SIGN_IN_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
export const SIGN_IN_GLOBAL_MAX_ATTEMPTS = 100;
export const SIGN_IN_GLOBAL_WINDOW_MS = 60 * 1000;

const GLOBAL_KEY = "sign-in:all";

export type SignInPermission =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type SignInLimiter = {
  /** Counts one attempt for this email address and says whether it may go on. */
  check(email: string): Promise<SignInPermission>;
  /** The sign in worked: the counter of this email address starts again. */
  succeeded(email: string): Promise<void>;
};

/** The same address however it is written (case, white space). */
export function normalizeSignInEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function accountKey(email: unknown): string {
  const hash = createHash("sha256")
    .update(normalizeSignInEmail(email), "utf8")
    .digest("hex");
  return `sign-in:email:${hash}`;
}

function secondsLeft(started: Date, windowMs: number, now: Date): number {
  return Math.max(
    1,
    Math.ceil((started.getTime() + windowMs - now.getTime()) / 1000),
  );
}

export function createSignInLimiter(
  rateLimits: RateLimitsRepository,
  now: () => Date = () => new Date(),
): SignInLimiter {
  return {
    async check(email) {
      const global = await rateLimits.hit(GLOBAL_KEY, SIGN_IN_GLOBAL_WINDOW_MS);
      if (global.count > SIGN_IN_GLOBAL_MAX_ATTEMPTS)
        return {
          allowed: false,
          retryAfterSeconds: secondsLeft(
            global.windowStartedAt,
            SIGN_IN_GLOBAL_WINDOW_MS,
            now(),
          ),
        };
      const account = await rateLimits.hit(
        accountKey(email),
        SIGN_IN_ACCOUNT_WINDOW_MS,
      );
      if (account.count > SIGN_IN_ACCOUNT_MAX_ATTEMPTS)
        return {
          allowed: false,
          retryAfterSeconds: secondsLeft(
            account.windowStartedAt,
            SIGN_IN_ACCOUNT_WINDOW_MS,
            now(),
          ),
        };
      return { allowed: true };
    },

    async succeeded(email) {
      await rateLimits.reset(accountKey(email));
    },
  };
}
