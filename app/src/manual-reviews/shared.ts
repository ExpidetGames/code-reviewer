// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server: the real database, registry, project service, settings and job
// queue behind the manual start.
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { jobQueueFor } from "../jobs/shared.ts";
import { projectServiceFor } from "../projects/shared.ts";
import { reviewSettingsServiceFor } from "../review-settings/shared.ts";
import {
  createManualReviewService,
  type ManualReviewService,
} from "./service.ts";

/** The manual review service of one workspace. */
export function manualReviewServiceFor(
  workspaceId: string,
): ManualReviewService {
  const db = getDatabase();
  const settings = reviewSettingsServiceFor(workspaceId);
  return createManualReviewService({
    repositories: createRepositoriesRepository(db, workspaceId),
    integrations: createIntegrationsRepository(db, workspaceId),
    projects: projectServiceFor(workspaceId),
    settings,
    registry: integrationRegistry,
    queue: jobQueueFor(workspaceId),
  });
}
