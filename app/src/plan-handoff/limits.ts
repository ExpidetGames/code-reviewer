// SPDX-License-Identifier: LicenseRef-Proprietary

// The limit on "Manage plan": counted per person and workspace in the shared `rate_limits` table, so every app
// instance counts the same clicks (docs/decisions/0001-editions-setup-and-accounts.md, section 2.10). The window is at
// most 24 hours, because the clean-up of old counters relies on it (src/maintenance/cleanup.ts, pinned by its test).
// A hash of the two ids is the key: no id is stored in clear.
import { createHash } from "node:crypto";
import { secondsLeft, type SignInPermission } from "../auth/sign-in-limit.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";

export const PLAN_HANDOFF_MAX = 10;
export const PLAN_HANDOFF_WINDOW_MS = 10 * 60 * 1000;

export type PlanHandoffLimits = {
  /** Counts one click of this person in this workspace. */
  hit(input: {
    workspaceId: string;
    userId: string;
  }): Promise<SignInPermission>;
};

export function planHandoffKey(workspaceId: string, userId: string): string {
  const hash = createHash("sha256")
    .update(`${workspaceId}\n${userId}`, "utf8")
    .digest("hex");
  return `plan-handoff:${hash}`;
}

export function createPlanHandoffLimits(
  rateLimits: RateLimitsRepository,
  now: () => Date = () => new Date(),
): PlanHandoffLimits {
  return {
    async hit({ workspaceId, userId }) {
      const hit = await rateLimits.hit(
        planHandoffKey(workspaceId, userId),
        PLAN_HANDOFF_WINDOW_MS,
      );
      if (hit.count <= PLAN_HANDOFF_MAX) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: secondsLeft(
          hit.windowStartedAt,
          PLAN_HANDOFF_WINDOW_MS,
          now(),
        ),
      };
    },
  };
}
