// SPDX-License-Identifier: Apache-2.0

// The review settings service: what the routes, the claim of the runner API and the webhook intake
// use to read and change the settings. It validates input, keeps the layers apart (the global
// defaults in `app_settings`, the overrides of a project in `projects.settings`), computes the
// settings a review of a project uses, and maps every refusal to a stable `ReviewSettingsError`.
// All SQL is in the repositories.
import type { AppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import type {
  ProjectsRepository,
  ProjectSettings,
  StoredProject,
} from "../db/repositories/projects-repository.ts";
import {
  estimateReviewCost,
  modelsExceedingContext,
  type ReviewCostGuard,
} from "./cost.ts";
import {
  readDefaultReviewSkill,
  type DefaultReviewSkill,
} from "./default-skill.ts";
import {
  resolveProjectDynamicSettings,
  resolveReviewSettings,
  type EffectiveProjectDynamic,
  type EffectiveReviewSettings,
  type SettingSource,
} from "./effective.ts";
import { ReviewSettingsError } from "./errors.ts";
import type { ReviewSettingsHooks } from "./hooks.ts";
import { noopReviewSettingsHooks } from "./hooks.ts";
import {
  builtInProjectDynamicSettings,
  PROJECT_DYNAMIC_LIMITS,
  type ProjectDynamicOverrides,
  type ProjectDynamicSettingField,
  type ProjectDynamicSettings,
  type ProjectReviewKind,
  type ReviewSettingField,
  type ReviewSettings,
  type ReviewSettingsOverrides,
} from "./settings.ts";
import {
  parseStoredOverrides,
  parseStoredProjectDynamicOverrides,
  validateProjectSettingsPatch,
  validateReviewSettingsPatch,
  type ProjectSettingsPatch,
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
  /** The project-only review kind, Dynamic model and skill (#194). */
  dynamic: ProjectDynamicView;
};

/**
 * The project-only settings as a reader sees them (#194): the kind, the Dynamic model and the skill,
 * each with where it comes from, the shipped default it falls back to, and the size limit of an
 * override.
 */
export type ProjectDynamicView = {
  /** The project-only fields this project sets. */
  overrides: ProjectDynamicOverrides;
  /** The kind, Dynamic model and skill a review would use. */
  effective: {
    reviewKind: ProjectReviewKind;
    dynamicModel: string;
    /** The text a Dynamic review uses: the project's override, else the shipped default. */
    reviewSkill: string;
  };
  /** Where each effective value comes from (there is no global layer for these fields). */
  sources: Record<ProjectDynamicSettingField, "built_in" | "project">;
  /** What applies when the project sets nothing. */
  defaults: {
    reviewKind: ProjectReviewKind;
    dynamicModel: string;
    reviewSkill: string;
  };
  /** Whether the effective skill is the shipped default (the project sets no override). */
  reviewSkillIsDefault: boolean;
  /** The identity of the shipped default skill (the seam #198 replaces with the attributed asset). */
  defaultSkill: { id: string; version: string; hash: string };
  /** The bounds an override is held to. */
  limits: { reviewSkillMaxBytes: number };
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
  ): Promise<ResolvedProjectSettings | undefined>;
};

/** The Diff settings of a project plus its project-only kind, model and skill (#194). */
export type ResolvedProjectSettings = EffectiveReviewSettings & {
  dynamic: EffectiveProjectDynamic;
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

/** Validates the Diff and project-only fields of a project save (#194). */
function checkedProject(input: unknown): ProjectSettingsPatch {
  const result = validateProjectSettingsPatch(input);
  if (!result.ok)
    throw new ReviewSettingsError(
      "REVIEW_SETTINGS_INVALID",
      "Some settings are not valid.",
      result.issues,
    );
  return result.value;
}

/**
 * The settings a project save stores: the Diff overrides are replaced as a whole (a field left out is
 * inherited again), while the project-only fields are merged over the stored ones. That is what lets
 * a save that does not know them (the current form, an older client) keep the review kind, the
 * Dynamic model and a skill override instead of dropping them. A `reviewSkill` of `null` clears the
 * override and resolves to the shipped default.
 */
function mergeProjectSettings(
  current: ProjectSettings,
  patch: ProjectSettingsPatch,
): ProjectSettings {
  const storedDynamic = parseStoredProjectDynamicOverrides(current);
  const dynamic: ProjectDynamicOverrides = {
    ...storedDynamic,
    ...patch.dynamic,
  };
  const next: ProjectSettings = { ...patch.review };
  if (dynamic.reviewKind !== undefined) next.reviewKind = dynamic.reviewKind;
  if (dynamic.dynamicModel !== undefined)
    next.dynamicModel = dynamic.dynamicModel;
  if (dynamic.reviewSkill !== undefined && dynamic.reviewSkill !== null)
    next.reviewSkill = dynamic.reviewSkill;
  return next;
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
  /** The project-only defaults of the instance (Diff Review, the shipped Dynamic model). */
  dynamicDefaults?: () => ProjectDynamicSettings;
  /** The shipped default skill; the seam #198 replaces with the attributed asset. */
  defaultSkill?: () => DefaultReviewSkill;
  /** What reacts to a settings change; #195 cancels waiting reviews on a kind change. */
  hooks?: ReviewSettingsHooks;
}): ReviewSettingsService {
  const { appSettings, projects } = deps;
  const dynamicDefaults =
    deps.dynamicDefaults ?? (() => builtInProjectDynamicSettings());
  const defaultSkill = deps.defaultSkill ?? readDefaultReviewSkill;
  const hooks = deps.hooks ?? noopReviewSettingsHooks;

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

  /** The project-only settings of a project, with their sources, defaults and limits. */
  function dynamicView(project: StoredProject | undefined): ProjectDynamicView {
    const defaults = dynamicDefaults();
    const shipped = defaultSkill();
    const overrides = parseStoredProjectDynamicOverrides(project?.settings);
    const effective = resolveProjectDynamicSettings({
      builtIn: defaults,
      project: overrides,
      defaultSkill: shipped.text,
    });
    return {
      overrides,
      effective: {
        reviewKind: effective.reviewKind,
        dynamicModel: effective.dynamicModel,
        reviewSkill: effective.reviewSkill,
      },
      sources: effective.sources,
      defaults: {
        reviewKind: defaults.reviewKind,
        dynamicModel: defaults.dynamicModel,
        reviewSkill: shipped.text,
      },
      reviewSkillIsDefault: effective.reviewSkillIsDefault,
      defaultSkill: {
        id: shipped.id,
        version: shipped.version,
        hash: shipped.hash,
      },
      limits: {
        reviewSkillMaxBytes: PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes,
      },
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
      dynamic: dynamicView(project),
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
      const patch = checkedProject(input);
      refuseBudgetAboveContext(
        patch.review,
        resolveReviewSettings({
          builtIn: deps.builtIn(),
          global: (await readGlobal()).overrides,
          project: patch.review,
        }).settings,
      );
      let previousKind: ProjectReviewKind = "diff";
      let kindChanged = false;
      const project = await projects.updateSettingsWith(
        repositoryId,
        (current) => {
          const next = mergeProjectSettings(current, patch);
          const before =
            parseStoredProjectDynamicOverrides(current).reviewKind ?? "diff";
          const after =
            parseStoredProjectDynamicOverrides(next).reviewKind ?? "diff";
          previousKind = before;
          kindChanged = before !== after;
          return next;
        },
        async (updated, executor) => {
          await hooks.onProjectSettingsChanged(
            {
              projectId: updated.id,
              repositoryId: updated.repositoryId,
              previousKind,
              nextKind:
                parseStoredProjectDynamicOverrides(updated.settings)
                  .reviewKind ?? "diff",
              kindChanged,
            },
            executor,
          );
        },
      );
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
      const review = resolveReviewSettings({
        builtIn: deps.builtIn(),
        global: (await readGlobal()).overrides,
        project: parseStoredOverrides(project.settings),
      });
      const dynamic = resolveProjectDynamicSettings({
        builtIn: dynamicDefaults(),
        project: parseStoredProjectDynamicOverrides(project.settings),
        defaultSkill: defaultSkill().text,
      });
      return { ...review, dynamic };
    },
  };
}
