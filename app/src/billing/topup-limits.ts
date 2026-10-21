// SPDX-License-Identifier: Apache-2.0

// The limit on starting a top-up: every start can make a customer and a Checkout Session at Stripe, so a person who is
// signed in cannot ask for them without end. Counted per person and workspace in the shared `rate_limits` table, so every
// app instance counts the same clicks (docs/decisions/0001-editions-setup-and-accounts.md, section 2.10). The window is at
// most 24 hours, because the clean-up of old counters relies on it (src/maintenance/cleanup.ts, pinned by its test). A hash
// of the two ids is the key: no id is stored in clear.
import { createHash } from "node:crypto";
import "server-only";
import { secondsLeft } from "../auth/sign-in-limit.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";

export const TOP_UP_REQUESTS_MAX = 10;
export const TOP_UP_REQUESTS_WINDOW_MS = 10 * 60 * 1000;
/**
 * The starts of the whole instance in the same window: every one can make a customer and a Checkout Session at Stripe, and
 * the API key is one for all workspaces, so many people together (or many workspaces) must not use up its rate limit. A
 * little over what one busy hour of real use needs.
 */
export const TOP_UP_INSTANCE_REQUESTS_MAX = 200;
export const TOP_UP_INSTANCE_LIMIT_KEY = "billing-top-up:instance";

export type TopUpPermission =
  | { allowed: true }
  | {
      allowed: false;
      /** Whose count is full: this person in this workspace, or the instance. */
      scope: "person" | "instance";
      retryAfterSeconds: number;
    };

export type TopUpLimits = {
  /** Counts one start of this person in this workspace, and of the instance. A rejection is the caller's to fail closed on. */
  hit(input: { workspaceId: string; userId: string }): Promise<TopUpPermission>;
};

export function topUpLimitKey(workspaceId: string, userId: string): string {
  const hash = createHash("sha256")
    .update(`${workspaceId}\n${userId}`, "utf8")
    .digest("hex");
  return `billing-top-up:${hash}`;
}

export function createTopUpLimits(
  rateLimits: RateLimitsRepository,
  now: () => Date = () => new Date(),
): TopUpLimits {
  return {
    async hit({ workspaceId, userId }) {
      const personKey = topUpLimitKey(workspaceId, userId);
      const person = await rateLimits.hit(personKey, TOP_UP_REQUESTS_WINDOW_MS);
      if (person.count > TOP_UP_REQUESTS_MAX)
        return {
          allowed: false,
          scope: "person",
          retryAfterSeconds: secondsLeft(
            person.windowStartedAt,
            TOP_UP_REQUESTS_WINDOW_MS,
            now(),
          ),
        };
      const instance = await rateLimits.hit(
        TOP_UP_INSTANCE_LIMIT_KEY,
        TOP_UP_REQUESTS_WINDOW_MS,
      );
      if (instance.count <= TOP_UP_INSTANCE_REQUESTS_MAX)
        return { allowed: true };
      // A start the instance refuses did not happen: it does not use up the person's allowance, and not the instance's.
      await rateLimits.refund(personKey);
      await rateLimits.refund(TOP_UP_INSTANCE_LIMIT_KEY);
      return {
        allowed: false,
        scope: "instance",
        retryAfterSeconds: secondsLeft(
          instance.windowStartedAt,
          TOP_UP_REQUESTS_WINDOW_MS,
          now(),
        ),
      };
    },
  };
}
