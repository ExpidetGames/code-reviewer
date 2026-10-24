// SPDX-License-Identifier: LicenseRef-Proprietary

// The job options of the running server: the review settings of the job's repository, the project's
// overrides over the global defaults over the built-in values (CR-25), turned into the fields of a job
// by `toRunnerSettings`. The claim asks once per job, so a change of the settings reaches the next
// job that is claimed, not only the next one that is queued.
import type { ReviewSettingsService } from "../review-settings/service.ts";
import { toRunnerSettings } from "../review-settings/runner-settings.ts";
import type { JobOptionsSource } from "./job-options.ts";

export function createReviewSettingsJobOptionsSource(deps: {
  /** The settings service of the workspace the claimed job belongs to (`job.workspaceId`). */
  settings: (
    workspaceId: string,
  ) => Pick<ReviewSettingsService, "resolveForRepository">;
}): JobOptionsSource {
  return {
    async optionsFor(job) {
      const resolved = await deps
        .settings(job.workspaceId)
        .resolveForRepository(job.repositoryId);
      // No project: the claim guard refuses such a job before it asks for options, so this is a job
      // that raced with a deletion. No options is the safe answer (the runner's defaults apply).
      if (resolved === undefined) return { env: {} };
      // #195 (finding 2): the branch follows the **job's pinned kind**, never the project's current
      // kind. A settings save can run after the atomic claim but before this call; whichever way the
      // kind moved, the claimed job keeps the options of the kind it was queued for.
      if (job.reviewKind === "dynamic")
        return {
          // A Dynamic job gets the model of the project, else of the workspace default (#676), and its skill, and **no**
          // PR-Agent env: those options grant nothing to the read-only agent and must never be promoted into its permissions.
          env: {},
          selection: {
            layers: resolved.modelLayers.dynamic,
            entryId: resolved.dynamic.catalogEntryDynamic,
          },
          llm: {
            model: resolved.dynamic.dynamicModel,
            maxTokens: resolved.settings.maxTokens,
            maxCostCents: resolved.settings.maxCostCents,
          },
          dynamic: {
            model: resolved.dynamic.dynamicModel,
            skill: resolved.dynamic.reviewSkill,
            maxFindings: resolved.settings.maxFindings,
          },
        };
      // A Diff job keeps the PR-Agent options of the effective Diff settings, even if the project was
      // switched to Dynamic after it was claimed. `toRunnerSettings` never depends on the kind.
      const { llm, env, fallbackModels } = toRunnerSettings(resolved.settings);
      return {
        env,
        selection: {
          layers: resolved.modelLayers.diff,
          entryId: resolved.dynamic.catalogEntryDiff,
        },
        llm: {
          ...llm,
          fallbackModels,
          maxCostCents: resolved.settings.maxCostCents,
        },
      };
    },
  };
}
