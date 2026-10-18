// SPDX-License-Identifier: Apache-2.0

// The wiring of the operator API on the running server: the real database and the token from the environment.
// The route files call `withOperatorApi` only. If the API cannot be set up (the database was not opened, say),
// the caller gets the generic 500 of the API and the log gets the cause, never a token.
import "server-only";
import { notFound } from "next/navigation";
import { createPlanHandoffRedeemRepository } from "../db/repositories/plan-handoff-redeem-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createUsageFeedRepository } from "../db/repositories/usage-feed-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { modelCapabilities } from "../llm/shared.ts";
import { createModelTiersService } from "../model-tiers/service.ts";
import { consoleRunnerApiLogger, describeError } from "../runner-api/logger.ts";
import { isBillingSwitchedOn } from "../billing/switch.ts";
import { createOperatorApi, type OperatorApi } from "./api.ts";
import type { OperatorRoute } from "./contract.ts";
import { errorResponse } from "./responses.ts";
import { configuredOperatorToken } from "./token.ts";

export function getOperatorApi(): OperatorApi {
  const db = getDatabase();
  return createOperatorApi({
    token: () => configuredOperatorToken(process.env),
    workspaces: createWorkspacesRepository(db),
    entitlementsFor: (workspaceId) =>
      createWorkspaceEntitlementsRepository(db, workspaceId),
    settings: createInstanceSettingsRepository(db),
    billingOn: () => isBillingSwitchedOn(db),
    usageFeed: createUsageFeedRepository(db),
    usageFor: (workspaceId) => createUsageRecordsRepository(db, workspaceId),
    handoffs: createPlanHandoffRedeemRepository(db),
    modelTiers: createModelTiersService({
      settings: createInstanceSettingsRepository(db),
      modelCapabilities,
    }),
    now: () => new Date(),
    logger: consoleRunnerApiLogger,
    notFound,
  });
}

/**
 * What the route files call. While no usable token is configured the answer is the 404 of a path that does not
 * exist, and the database is not even opened.
 */
export async function withOperatorApi(
  request: Request,
  route: OperatorRoute,
): Promise<Response> {
  if (configuredOperatorToken(process.env) === undefined) notFound();
  let api: OperatorApi;
  try {
    api = getOperatorApi();
  } catch (error) {
    consoleRunnerApiLogger.error(
      `[operator-api] the API could not be set up: ${describeError(error)}`,
    );
    return errorResponse(500, "internal_error");
  }
  return api.handle(request, route);
}
