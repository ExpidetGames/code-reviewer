// SPDX-License-Identifier: Apache-2.0

// WHETHER the notice of a refused review carries a link to the plan page (#281 built the address, #284 owns the
// setting that turns it on): it does exactly while the instance has an operator-configured plan management page
// (`plan_management_url`, src/plan-handoff/). The link is the plan page of the workspace in this app
// (`planReturnPath`, plan-page.ts), where an Owner or Admin finds "Manage plan"; it is never the address of
// the operator's page and carries no token. The base address is the configured address of the app, never a request.
import type { InstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { readPlanManagementUrl } from "../plan-handoff/settings.ts";
import { planPageUrl } from "./plan-page.ts";

export type PlanPageUrlResolver = (
  workspaceSlug: string,
) => Promise<string | null>;

export function createPlanPageUrlResolver({
  settings,
  baseUrl,
}: {
  settings: Pick<InstanceSettingsRepository, "get">;
  /** The configured public address of the app (`BETTER_AUTH_URL`), read when a link is made. */
  baseUrl: () => string;
}): PlanPageUrlResolver {
  return async (workspaceSlug) => {
    if ((await readPlanManagementUrl(settings)) === null) return null;
    return planPageUrl(baseUrl(), workspaceSlug);
  };
}
