// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server: the real database and the model of the instance. The webhook
// intake and the claim of the runner API get the settings of a project from here.
import "server-only";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createJobReviewSettingsHooks } from "../jobs/review-settings-hooks.ts";
import { configuredLlmModel } from "../llm/config.ts";
import { modelCapabilities } from "../llm/shared.ts";
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
  return createReviewSettingsService({
    appSettings: createAppSettingsRepository(db, workspaceId),
    projects: createProjectsRepository(db, workspaceId),
    // #195: a kind change cancels the project's waiting review jobs in this transaction.
    hooks: createJobReviewSettingsHooks(workspaceId),
    modelCapabilities,
    // Read on every call, so a changed LLM_MODEL reaches the next review.
    builtIn: () => builtInReviewSettings(configuredLlmModel(process.env)),
  });
}
