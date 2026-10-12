// SPDX-License-Identifier: Apache-2.0

// The review settings service: what the routes, the claim of the runner API and the webhook intake
// use to read and change the settings. It validates input, keeps the layers apart (the global
// defaults in `app_settings`, the overrides of a project in `projects.settings`), computes the
// settings a review of a project uses, and maps every refusal to a stable `ReviewSettingsError`.
// All SQL is in the repositories.
import type { AppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import type {
  ProjectsRepository,
  StoredProject,
} from "../db/repositories/projects-repository.ts";
import {
  estimateReviewCost,
  modelsExceedingContext,
  type ReviewCostGuard,
} from "./cost.ts";
import {
  resolveReviewSettings,
  type EffectiveReviewSettings,
  type SettingSource,
} from "./effective.ts";
import { ReviewSettingsError } from "./errors.ts";
import {
  type ReviewSettingField,
  type ReviewSettings,
  type ReviewSettingsOverrides,
} from "./settings.ts";
import {
  parseStoredOverrides,
  validateReviewSettingsPatch,
  type ReviewSettingIssue,
} from "./validate.ts";

/** The key of the global defaults in `app_settings`. */
export const REVIEW_DEFAULTS_KEY = "review_defaults";

type ViewBase = {
  /** The fields this layer sets; every other field is inherited. */
  overrides: ReviewSettingsOverrides;
  /** The settings a review uses at this level. */
  effective: ReviewSettings;
  /** Where each field of `effective` comes from. */
  sources: Record<ReviewSettingField, SettingSource>;
  /** What a review is expected to cost with these settings, and whether that is above the limit. */
  cost: ReviewCostGuard;
};

export type GlobalSettingsView = ViewBase & {
  /** The values nobody changed. */
  builtIn: ReviewSettings;
  /** ISO 8601 time of the last change, or null when the defaults were never saved. */
  updatedAt: string | null;
  /** The GitHub login of the person who saved them last, or null. */
  updatedBy: string | null;
};

export type ProjectSettingsView = ViewBase & {
  repositoryId: string;
  /** Null for a repository that has no project row yet (never activated, nothing saved). */
  projectId: string | null;
  /** Whether reviews run for the project; false for a repository that was never activated. */
  active: boolean;
  /** What the project would use without its own overrides (the global level). */
  inherited: ReviewSettings;
};

export type ReviewSettingsService = {
  getGlobalSettings(): Promise<GlobalSettingsView>;
  /**
   * Replaces the global defaults with the given fields (a field left out goes back to the built-in
   * value). Throws `REVIEW_SETTINGS_INVALID`.
   */
  updateGlobalSettings(
    input: unknown,
    actor: string,
  ): Promise<GlobalSettingsView>;
  /**
   * The settings of a repository's project; a repository that was never activated shows the defaults
   * (no overrides, `projectId` null). Throws `REVIEW_SETTINGS_PROJECT_NOT_FOUND` for a repository
   * that does not exist or that the platform no longer lists and that has no project.
   */
  getProjectSettings(repositoryId: string): Promise<ProjectSettingsView>;
  /**
   * Replaces the overrides of a project with the given fields (a field left out is inherited). A
   * repository that was never activated gets an inactive project, so it can be configured first.
   * Throws `REVIEW_SETTINGS_INVALID` or `REVIEW_SETTINGS_PROJECT_NOT_FOUND`.
   */
  updateProjectSettings(
    repositoryId: string,
    input: unknown,
  ): Promise<ProjectSettingsView>;
  /**
   * Removes every override of a project, so it follows the global defaults again. A repository
   * without a project has none to remove: nothing is written.
   */
  resetProjectSettings(repositoryId: string): Promise<ProjectSettingsView>;
  /**
   * The settings a review of the repository's project uses (project over global over built-in), or
   * undefined when the repository has no project row. It also answers for a row that is switched off
   * (one that only holds saved settings), so it is **not** a gate: the claim, the webhook intake and
   * the manual start check for an active project first (`hasActiveProject`,
   * `getActiveProjectForRepository`) and only then ask for the settings.
   */
  resolveForRepository(
    repositoryId: string,
  ): Promise<EffectiveReviewSettings | undefined>;
};

function notFound(): ReviewSettingsError {
  return new ReviewSettingsError(
    "REVIEW_SETTINGS_PROJECT_NOT_FOUND",
    "There is no such repository.",
  );
}

function checked(input: unknown): ReviewSettingsOverrides {
  const result = validateReviewSettingsPatch(input);
  if (!result.ok)
    throw new ReviewSettingsError(
      "REVIEW_SETTINGS_INVALID",
      "Some settings are not valid.",
      result.issues,
    );
  return result.value;
}

/**
 * The token budget must fit into the context window of the models the settings would use. Only the
 * fields the request sets are blamed: a combination that was there before (a project's budget that a
 * later change of the global model made too large) is not this request's problem, the cost guard
 * shows it (`exceedsContext`).
 */
function refuseBudgetAboveContext(
  patch: ReviewSettingsOverrides,
  effective: ReviewSettings,
): void {
  const issues: ReviewSettingIssue[] = [];
  for (const field of modelsExceedingContext(effective)) {
    const blamed: ReviewSettingField | undefined =
      patch.maxTokens !== undefined
        ? "maxTokens"
        : patch[field] !== undefined
          ? field
          : undefined;
    if (blamed !== undefined && !issues.some((i) => i.field === blamed))
      issues.push({ field: blamed, code: "EXCEEDS_MODEL_CONTEXT" });
  }
  if (issues.length > 0)
    throw new ReviewSettingsError(
      "REVIEW_SETTINGS_INVALID",
      "Some settings are not valid.",
      issues,
    );
}

export function createReviewSettingsService(deps: {
  appSettings: AppSettingsRepository;
  projects: ProjectsRepository;
  /** The values nobody changed; the model is the instance's (`LLM_MODEL`). */
  builtIn: () => ReviewSettings;
}): ReviewSettingsService {
  const { appSettings, projects } = deps;

  async function readGlobal() {
    const stored = await appSettings.get(REVIEW_DEFAULTS_KEY);
    return {
      overrides: parseStoredOverrides(stored?.value),
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: stored?.updatedBy ?? null,
    };
  }

  function viewOf(
    effective: EffectiveReviewSettings,
    overrides: ReviewSettingsOverrides,
  ): ViewBase {
    return {
      overrides,
      effective: effective.settings,
      sources: effective.sources,
      cost: estimateReviewCost(effective.settings),
    };
  }

  async function globalView(): Promise<GlobalSettingsView> {
    const builtIn = deps.builtIn();
    const global = await readGlobal();
    const effective = resolveReviewSettings({
      builtIn,
      global: global.overrides,
    });
    return {
      ...viewOf(effective, global.overrides),
      builtIn,
      updatedAt: global.updatedAt,
      updatedBy: global.updatedBy,
    };
  }

  async function projectView(
    repositoryId: string,
    project: StoredProject | undefined,
  ): Promise<ProjectSettingsView> {
    const builtIn = deps.builtIn();
    const global = (await readGlobal()).overrides;
    const overrides = parseStoredOverrides(project?.settings);
    const effective = resolveReviewSettings({
      builtIn,
      global,
      project: overrides,
    });
    return {
      ...viewOf(effective, overrides),
      repositoryId,
      projectId: project?.id ?? null,
      active: project?.active ?? false,
      inherited: resolveReviewSettings({ builtIn, global }).settings,
    };
  }

  // The view of a repository that has no project row yet is the defaults; one the list does not show
  // (unknown, or no longer listed by the platform and without a project) is not found.
  async function viewOfRepository(
    repositoryId: string,
  ): Promise<ProjectSettingsView> {
    const entry = await projects.find(repositoryId);
    if (entry === undefined) throw notFound();
    return projectView(repositoryId, entry.project ?? undefined);
  }

  return {
    getGlobalSettings: globalView,

    async updateGlobalSettings(input, actor) {
      const overrides = checked(input);
      refuseBudgetAboveContext(
        overrides,
        resolveReviewSettings({ builtIn: deps.builtIn(), global: overrides })
          .settings,
      );
      await appSettings.set(REVIEW_DEFAULTS_KEY, overrides, actor);
      return globalView();
    },

    async getProjectSettings(repositoryId) {
      return viewOfRepository(repositoryId);
    },

    async updateProjectSettings(repositoryId, input) {
      const overrides = checked(input);
      refuseBudgetAboveContext(
        overrides,
        resolveReviewSettings({
          builtIn: deps.builtIn(),
          global: (await readGlobal()).overrides,
          project: overrides,
        }).settings,
      );
      const project = await projects.updateSettings(repositoryId, overrides);
      if (project === undefined) throw notFound();
      return projectView(repositoryId, project);
    },

    async resetProjectSettings(repositoryId) {
      // Nothing to remove, so no row is created just for this.
      if ((await projects.get(repositoryId)) === undefined)
        return viewOfRepository(repositoryId);
      const project = await projects.updateSettings(repositoryId, {});
      if (project === undefined) throw notFound();
      return projectView(repositoryId, project);
    },

    async resolveForRepository(repositoryId) {
      const project = await projects.get(repositoryId);
      if (project === undefined) return undefined;
      return resolveReviewSettings({
        builtIn: deps.builtIn(),
        global: (await readGlobal()).overrides,
        project: parseStoredOverrides(project.settings),
      });
    },
  };
}
