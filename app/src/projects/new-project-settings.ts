// SPDX-License-Identifier: LicenseRef-Proprietary

// What a project starts with (#656): Dynamic Review, the review kind new projects default to, but only where a Dynamic
// Review of this workspace can run its first review. That takes two things: the instance has turned Dynamic Review on
// (the #195 gate; with it off a Dynamic project's reviews fail) and the claim would find a model for the workspace. The
// second question is answered the way the claim answers it, so the two cannot drift:
//
//   - the operator's key (`managed`): the resolver finds a usable entry, which for a project that chose none is the
//     instance default entry of Dynamic Review (`catalog_defaults.dynamic`); with none, or one that is not released, does
//     not serve Dynamic Review or is not allowed by the plan, every review would be refused (`managed_model_unavailable`).
//   - the workspace's own key: the Dynamic Review of a project that chose nothing runs on the default provider, so a key
//     must be stored for it (otherwise `llm_not_configured`).
//
// Otherwise the project starts with no kind and keeps the built-in one (Diff Review). Only a row that is being created
// is given these; a project that exists keeps what it has, so switching the default never changes the reviews of a
// project that was set up before. The key itself is never read, only whether a row for it exists.
import type { Kysely } from "kysely";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type {
  NewProjectSettings,
  ProjectSettings,
} from "../db/repositories/projects-repository.ts";
import { createWorkspaceSecretsRepository } from "../db/repositories/workspace-secrets-repository.ts";
import type { Database } from "../db/schema.ts";
import { isDynamicReviewEnabled } from "../jobs/dynamic-review-gate.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { keyModeForJob } from "../llm/resolve.ts";
import { resolveModelSelection } from "../llm/selection.ts";
import { readStoredDefaults } from "../model-catalog/service.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import { noLimits } from "../workspaces/entitlements.ts";

/** Whether a Dynamic Review of a project that chose no model would find one in this workspace. */
async function dynamicReviewCanResolve(
  executor: Kysely<Database>,
  workspaceId: string,
): Promise<boolean> {
  const entitlements = await readEffectiveEntitlements(executor, workspaceId);
  const keyMode = keyModeForJob(entitlements);
  if (keyMode === "unreadable") return false;

  const { defaultProvider } = llmProviderDescriptors;
  if (keyMode === "own")
    return (
      (await createWorkspaceSecretsRepository(executor, workspaceId).get(
        defaultProvider.secretNames.workspace,
      )) !== undefined
    );

  const subject =
    entitlements.kind === "unlimited"
      ? noLimits("managed")
      : entitlements.kind === "limited"
        ? entitlements
        : undefined;
  if (subject === undefined) return false;
  const defaultEntryId = readStoredDefaults(
    await createInstanceSettingsRepository(executor).get("catalog_defaults"),
  ).dynamic;
  const entry =
    defaultEntryId === null
      ? undefined
      : await createCatalogRepository(executor).get(defaultEntryId);
  return resolveModelSelection({
    keyMode: "managed",
    kind: "dynamic",
    // Which providers the runner will advertise is not known yet; the providers of the app are what it can be given.
    runnerProviders: llmProviderDescriptors.ids,
    entitlements: subject,
    projectEntryId: null,
    defaultEntryId,
    entries: entry === undefined ? [] : [entry],
  }).ok;
}

export const newProjectSettings: NewProjectSettings = async (
  executor,
  workspaceId,
) => {
  const settings: ProjectSettings = {};
  if (
    (await isDynamicReviewEnabled(executor)) &&
    (await dynamicReviewCanResolve(executor, workspaceId))
  )
    settings.reviewKind = "dynamic";
  return settings;
};
