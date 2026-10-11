// The wiring of the running server: the real database, registry, project service, settings and job
// queue behind the manual start.
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { getJobQueue } from "../jobs/shared.ts";
import { getProjectService } from "../projects/shared.ts";
import { getReviewSettingsService } from "../review-settings/shared.ts";
import {
  createManualReviewService,
  type ManualReviewService,
} from "./service.ts";

/** The manual review service for the current request. */
export function getManualReviewService(): ManualReviewService {
  const db = getDatabase();
  return createManualReviewService({
    repositories: createRepositoriesRepository(db),
    integrations: createIntegrationsRepository(db),
    projects: getProjectService(),
    settings: getReviewSettingsService(),
    registry: integrationRegistry,
    queue: getJobQueue(),
  });
}
