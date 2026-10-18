// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server: the real database and the model of the instance. The webhook
// intake and the claim of the runner API get the settings of a project from here.
import "server-only";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createJobReviewSettingsHooks } from "../jobs/review-settings-hooks.ts";
import { configuredLlmModel } from "../llm/config.ts";
import { modelCapabilities } from "../llm/shared.ts";
import { createCatalogService } from "../model-catalog/service.ts";
import { createModelTiersService } from "../model-tiers/service.ts";
import { configuredTiers } from "../model-tiers/tiers.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import { keyModeForJob } from "../llm/resolve.ts";
import { catalogSelectionFrom } from "./catalog-selection.ts";
import {
  createReviewSettingsService,
  type ReviewSettingsService,
} from "./service.ts";
import { builtInReviewSettings } from "./settings.ts";

/** The review settings service of one workspace. */
export function reviewSettingsServiceFor(
  workspaceId: string,
): ReviewSettingsService {
  const db = getDatabase();
  const modelTiers = createModelTiersService({
    settings: createInstanceSettingsRepository(db),
    modelCapabilities,
  });
  const catalog = createCatalogService({
    catalog: createCatalogRepository(db),
    settings: createInstanceSettingsRepository(db),
    modelCapabilities,
    logger: { info: (line) => console.info(line) },
  });
  return createReviewSettingsService({
    appSettings: createAppSettingsRepository(db, workspaceId),
    projects: createProjectsRepository(db, workspaceId),
    // #195: a kind change cancels the project's waiting review jobs in this transaction.
    hooks: createJobReviewSettingsHooks(workspaceId),
    modelCapabilities,
    // #280, #283: the models of a workspace on the operator's key are the operator's, and the workspace's budget is not
    // checked against the stored one. Anything but the workspace's own key hides the model fields and the estimate,
    // including entitlements that cannot be read: the jobs fail closed then, and the page and the API must not show
    // what the workspace may not see. Read on every call, so a change of the key mode takes effect at once.
    operatorsModels: async () =>
      keyModeForJob(await readEffectiveEntitlements(db, workspaceId)) !== "own",
    // #283: for the quality choice, whether each level has a model for each kind: yes or no, never which model. Read
    // on every call, so a change of the operator's configuration shows at once.
    tierAvailability: async () => configuredTiers(await modelTiers.read()),
    // #430: the catalog a workspace on the operator's key picks from. Every released entry is allowed until the
    // `modelAccess` entitlement exists (#428); the service reads this only for a workspace on the operator's key.
    catalog: catalogSelectionFrom(catalog, async () => true),
    // Read on every call, so a changed LLM_MODEL reaches the next review.
    builtIn: () => builtInReviewSettings(configuredLlmModel(process.env)),
  });
}
