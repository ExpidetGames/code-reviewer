// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server: the real database and the model of the instance. The webhook
// intake and the claim of the runner API get the settings of a project from here.
import "server-only";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { newProjectSettings } from "../projects/new-project-settings.ts";
import { getDatabase } from "../db/startup.ts";
import { createJobReviewSettingsHooks } from "../jobs/review-settings-hooks.ts";
import { configuredLlmModel } from "../llm/config.ts";
import { modelCapabilities } from "../llm/shared.ts";
import { createCatalogService } from "../model-catalog/service.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import {
  entryAllowed,
  type ResolvedEntitlements,
} from "../workspaces/entitlements.ts";
import { keyModeForJob } from "../llm/resolve.ts";
import { getNativeCatalog } from "../native-providers/shared.ts";
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
  const catalog = createCatalogService({
    catalog: createCatalogRepository(db),
    settings: createInstanceSettingsRepository(db),
    modelCapabilities,
    logger: { info: (line) => console.info(line) },
  });
  // The service is made for one request. The key mode and every entry of the picker ask about the same entitlements, so
  // they are read once, on first use, and not once per question.
  let entitlements: Promise<ResolvedEntitlements> | undefined;
  const readEntitlements = () =>
    (entitlements ??= readEffectiveEntitlements(db, workspaceId));
  return createReviewSettingsService({
    appSettings: createAppSettingsRepository(db, workspaceId),
    projects: createProjectsRepository(
      db,
      workspaceId,
      undefined,
      undefined,
      undefined,
      undefined,
      newProjectSettings,
    ),
    // #195: a kind change cancels the project's waiting review jobs in this transaction.
    hooks: createJobReviewSettingsHooks(workspaceId),
    newProjectSettings: () => newProjectSettings(db),
    modelCapabilities,
    // #283: the models of a workspace on the operator's key are the operator's, and the workspace's budget is not
    // checked against the stored one. Anything but the workspace's own key hides the model fields and the estimate,
    // including entitlements that cannot be read: the jobs fail closed then, and the page and the API must not show
    // what the workspace may not see. Read for each request, so a change of the key mode takes effect at once.
    operatorsModels: async () =>
      keyModeForJob(await readEntitlements()) !== "own",
    // #430: the catalog a workspace on the operator's key picks from; the entitlements of the workspace decide which
    // entries it may pick (`modelAccess`, #428). Entitlements that cannot be read allow nothing. The service reads this
    // only for a workspace on the operator's key.
    catalog: catalogSelectionFrom(catalog, async (id) =>
      entryAllowed(await readEntitlements(), { id }),
    ),
    // #555: the catalog of providers and models a workspace on its own key picks for Dynamic Review.
    nativeCatalog: getNativeCatalog(),
    // Read on every call, so a changed LLM_MODEL reaches the next review.
    builtIn: () => builtInReviewSettings(configuredLlmModel(process.env)),
  });
}
