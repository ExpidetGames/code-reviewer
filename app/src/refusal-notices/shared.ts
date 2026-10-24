// SPDX-License-Identifier: LicenseRef-Proprietary

// The notice of a refused review on the running server (#281): the service over the real database and registry,
// and the hook the runner queue calls for every job its claim refused. The post runs after the response of the claim
// (`after()` on a serverless platform, which keeps the function alive for it; src/dispatch/shared.ts), never in a
// timer, and never delays or changes the claim.
import "server-only";
import { loadAuthConfig } from "../auth/config.ts";
import { isBillingOn } from "../billing/enabled.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { runAfterResponse } from "../dispatch/shared.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { assembleRefusalNoticeService } from "./assemble.ts";
import { createBillingAwareLinks } from "./billing-link.ts";
import { createPlanPageUrlResolver } from "./plan-link.ts";
import { createRefusalBatcher } from "./refusal-batch.ts";
import type { NoticeRefusal, RefusalNoticeService } from "./service.ts";

let service: RefusalNoticeService | undefined;

/** One service per process: its queue keeps a backlog of refusals from opening many requests at GitHub at once. */
export function getRefusalNoticeService(): RefusalNoticeService {
  if (service !== undefined) return service;
  const db = getDatabase();
  const baseUrl = () => loadAuthConfig(process.env).baseUrl;
  // While billing is on, the billing page of the workspace is where the notices lead (#505); otherwise nothing changes.
  const links = createBillingAwareLinks({
    isBillingOn: () => isBillingOn(db),
    baseUrl,
    // A link to the plan page exactly while the instance has a plan management page (#284).
    plan: createPlanPageUrlResolver({
      settings: createInstanceSettingsRepository(db),
      baseUrl,
    }),
  });
  service = assembleRefusalNoticeService({
    db,
    registry: integrationRegistry,
    planPageUrl: links.planPageUrl,
    // #498: a refusal for the balance or the monthly limit points to the billing page while billing is on, else to the settings.
    settingsUrl: links.settingsUrl,
    log: console,
  });
  return service;
}

// The refusals of a claim are gathered and deduplicated per pull request and period before one callback is
// scheduled for them all (refusal-batch.ts).
const batcher = createRefusalBatcher({
  schedule: runAfterResponse,
  handle: (refusal) => getRefusalNoticeService().onRefused(refusal),
});

/** What the runner queue calls for a refused job. Never throws. */
export function noticeOfRefusal(refusal: NoticeRefusal): void {
  batcher.add(refusal);
}
