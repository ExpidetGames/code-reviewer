// SPDX-License-Identifier: Apache-2.0

// The wiring of the plan handoff on the running server: the real database, the instance setting and the shared
// counters. The route files and the pages call these only.
import "server-only";
import { notFound } from "next/navigation";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createPlanHandoffTokensRepository } from "../db/repositories/plan-handoff-tokens-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createPlanHandoffRoute, type PlanHandoffRoute } from "./http.ts";
import { createPlanHandoffLimits } from "./limits.ts";
import { readPlanManagementUrl } from "./settings.ts";
import {
  createHandoffToken,
  HANDOFF_TOKEN_TTL_MS,
  hashHandoffToken,
} from "./token.ts";

/** The configured plan management page of the instance, or null: what decides whether "Manage plan" exists at all. */
export function getPlanManagementUrl(): Promise<string | null> {
  return readPlanManagementUrl(createInstanceSettingsRepository(getDatabase()));
}

export function getPlanHandoffRoute(): PlanHandoffRoute {
  const db = getDatabase();
  const limits = createPlanHandoffLimits(createRateLimitsRepository(db));
  return createPlanHandoffRoute({
    planManagementUrl: getPlanManagementUrl,
    notFound,
    async issue({ workspaceId, userId, role }) {
      const permission = await limits.hit({ workspaceId, userId });
      if (!permission.allowed)
        return {
          allowed: false,
          retryAfterSeconds: permission.retryAfterSeconds,
        };
      const token = createHandoffToken();
      await createPlanHandoffTokensRepository(db, workspaceId).issue({
        tokenHash: hashHandoffToken(token),
        userId,
        role,
        ttlMs: HANDOFF_TOKEN_TTL_MS,
      });
      return { allowed: true, token };
    },
    log: console,
  });
}
