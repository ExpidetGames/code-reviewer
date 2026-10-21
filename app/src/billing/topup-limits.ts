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
  return personKey("billing-top-up", workspaceId, userId);
}

function personKey(prefix: string, workspaceId: string, userId: string) {
  const hash = createHash("sha256")
    .update(`${workspaceId}\n${userId}`, "utf8")
    .digest("hex");
  return `${prefix}:${hash}`;
}

type LimitSettings = {
  keyOf: (workspaceId: string, userId: string) => string;
  instanceKey: string;
  personMax: number;
  instanceMax: number;
};

function createLimits(
  rateLimits: RateLimitsRepository,
  now: () => Date,
  { keyOf, instanceKey, personMax, instanceMax }: LimitSettings,
): TopUpLimits {
  return {
    async hit({ workspaceId, userId }) {
      const personKey = keyOf(workspaceId, userId);
      const person = await rateLimits.hit(personKey, TOP_UP_REQUESTS_WINDOW_MS);
      if (person.count > personMax)
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
        instanceKey,
        TOP_UP_REQUESTS_WINDOW_MS,
      );
      if (instance.count <= instanceMax) return { allowed: true };
      // A request the instance refuses did not happen: it does not use up the person's allowance, and not the instance's.
      await rateLimits.refund(personKey);
      await rateLimits.refund(instanceKey);
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

export function createTopUpLimits(
  rateLimits: RateLimitsRepository,
  now: () => Date = () => new Date(),
): TopUpLimits {
  return createLimits(rateLimits, now, {
    keyOf: topUpLimitKey,
    instanceKey: TOP_UP_INSTANCE_LIMIT_KEY,
    personMax: TOP_UP_REQUESTS_MAX,
    instanceMax: TOP_UP_INSTANCE_REQUESTS_MAX,
  });
}

/**
 * The limit on "Check payment" (#502): every check asks Stripe for a session, so it is counted like a start but apart from it
 * (a person who presses the button does not use up the allowance to start a top-up), per person and workspace and for the
 * whole instance, in the same window.
 */
export const CHECK_PAYMENT_REQUESTS_MAX = 20;
export const CHECK_PAYMENT_INSTANCE_REQUESTS_MAX = 300;
export const CHECK_PAYMENT_INSTANCE_LIMIT_KEY =
  "billing-check-payment:instance";

export function createCheckPaymentLimits(
  rateLimits: RateLimitsRepository,
  now: () => Date = () => new Date(),
): TopUpLimits {
  return createLimits(rateLimits, now, {
    keyOf: (workspaceId, userId) =>
      personKey("billing-check-payment", workspaceId, userId),
    instanceKey: CHECK_PAYMENT_INSTANCE_LIMIT_KEY,
    personMax: CHECK_PAYMENT_REQUESTS_MAX,
    instanceMax: CHECK_PAYMENT_INSTANCE_REQUESTS_MAX,
  });
}
