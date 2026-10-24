// SPDX-License-Identifier: LicenseRef-Proprietary

// The limits of the binding of an installation (docs/decisions/0001-editions-setup-and-accounts.md, sections
// 2.9 and 2.10): the shared counters of the database (src/db/repositories/rate-limits-repository.ts), never
// memory, so every app instance counts the same attempts. Three counters, each per person and for the instance:
//
// - `start`: beginning a connection (Connect, the list of installations, a choice from it), which makes a
//   signed state and an address on GitHub;
// - `callback`: what comes back from GitHub (the setup address and the authorization), which makes calls to
//   GitHub with the person's token;
// - `sync`: the workspace's "Sync from GitHub" button, which reads the workspace's installations with the App's
//   own credentials.
//
// The person's counter is the allowance of each person; the instance counter is only a backstop against a flood
// from many accounts, so a few people cannot use up everybody's budget. A person over their own allowance gets
// their attempt taken back from the instance counter.
import { secondsLeft } from "../auth/sign-in-limit.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";

export const BINDING_WINDOW_MS = 10 * 60 * 1000;
export const BINDING_USER_MAX = 10;
export const BINDING_GLOBAL_MAX = 2000;

export const BINDING_LIMITS = ["start", "callback", "sync"] as const;
export type BindingLimit = (typeof BINDING_LIMITS)[number];

export function bindingUserKey(limit: BindingLimit, userId: string): string {
  return `installation-binding-${limit}:user:${userId}`;
}
export function bindingGlobalKey(limit: BindingLimit): string {
  return `installation-binding-${limit}:all`;
}

export type LimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export async function hitBindingLimit(
  rateLimits: RateLimitsRepository,
  limit: BindingLimit,
  userId: string,
  now: Date,
): Promise<LimitResult> {
  const denied = (hit: { windowStartedAt: Date }): LimitResult => ({
    allowed: false,
    retryAfterSeconds: secondsLeft(hit.windowStartedAt, BINDING_WINDOW_MS, now),
  });
  const instance = await rateLimits.hit(
    bindingGlobalKey(limit),
    BINDING_WINDOW_MS,
  );
  if (instance.count > BINDING_GLOBAL_MAX) return denied(instance);
  const own = await rateLimits.hit(
    bindingUserKey(limit, userId),
    BINDING_WINDOW_MS,
  );
  if (own.count > BINDING_USER_MAX) {
    await rateLimits.refund(bindingGlobalKey(limit));
    return denied(own);
  }
  return { allowed: true };
}
