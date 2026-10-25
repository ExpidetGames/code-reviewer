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
//
// The workspace default of the review kind (#676) comes first: a workspace that chose Diff Review gets Diff Review, and one
// that chose Dynamic Review gets it where a Dynamic Review can run its first review, judged with the Dynamic provider and
// model (or catalog entry) the workspace chose; where it cannot, the project starts on Diff Review and says so in its
// settings (the #664 safety). A project that follows the default stores no kind, so a later change of the default reaches it.
import type { Kysely } from "kysely";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
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
import { REVIEW_DEFAULTS_KEY } from "../review-settings/settings.ts";
import { parseStoredWorkspaceDynamic } from "../review-settings/validate.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import { noLimits } from "../workspaces/entitlements.ts";

/**
 * Whether a Dynamic Review of a project that chose no model of its own would find one in this workspace: the one the
 * workspace default chose (#676), else the instance's.
 */
export async function dynamicReviewCanResolve(
  executor: Kysely<Database>,
  workspaceId: string,
  workspaceDefault: ReturnType<typeof parseStoredWorkspaceDynamic>,
): Promise<boolean> {
  const entitlements = await readEffectiveEntitlements(executor, workspaceId);
  const keyMode = keyModeForJob(entitlements);
  if (keyMode === "unreadable") return false;

  if (keyMode === "own") {
    // The provider the workspace chose, else the default one (the registry only: a catalog provider is a project's choice).
    const provider =
      (workspaceDefault.dynamicProvider === undefined
        ? undefined
        : llmProviderDescriptors.find(workspaceDefault.dynamicProvider)) ??
      llmProviderDescriptors.defaultProvider;
    return (
      (await createWorkspaceSecretsRepository(executor, workspaceId).get(
        provider.secretNames.workspace,
      )) !== undefined
    );
  }

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
  const workspaceEntryId = workspaceDefault.catalogEntryDynamic ?? null;
  const catalog = createCatalogRepository(executor);
  const entries = [];
  for (const id of new Set([workspaceEntryId, defaultEntryId])) {
    const entry = id === null ? undefined : await catalog.get(id);
    if (entry !== undefined) entries.push(entry);
  }
  return resolveModelSelection({
    keyMode: "managed",
    kind: "dynamic",
    // Which providers the runner will advertise is not known yet; the providers of the app are what it can be given.
    runnerProviders: llmProviderDescriptors.ids,
    entitlements: subject,
    // A project that chose nothing follows the workspace default, which is the entry the claim would use for it.
    projectEntryId: workspaceEntryId,
    defaultEntryId,
    entries,
  }).ok;
}

export const newProjectSettings: NewProjectSettings = async (
  executor,
  workspaceId,
) => {
  const settings: ProjectSettings = {};
  const workspaceDefault = parseStoredWorkspaceDynamic(
    (
      await createAppSettingsRepository(executor, workspaceId).get(
        REVIEW_DEFAULTS_KEY,
      )
    )?.value,
  );
  // The workspace chose Diff Review: the project follows it and stores nothing.
  if (workspaceDefault.reviewKind === "diff") return settings;
  const canRun =
    (await isDynamicReviewEnabled(executor)) &&
    (await dynamicReviewCanResolve(executor, workspaceId, workspaceDefault));
  if (workspaceDefault.reviewKind === "dynamic") {
    // Follows the default where it can run; otherwise Diff Review is stored, so the first review does not fail.
    if (!canRun) settings.reviewKind = "diff";
    return settings;
  }
  if (canRun) settings.reviewKind = "dynamic";
  return settings;
};
