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
import type { ModelCapabilityChecker } from "../llm/model-capabilities.ts";
import { ReviewSettingsError } from "./errors.ts";
import type { ReviewSettingsHooks } from "./hooks.ts";
import { noopReviewSettingsHooks } from "./hooks.ts";
import {
  configuredTiers,
  type TierAvailability,
} from "../model-tiers/tiers.ts";
import {
  builtInProjectDynamicSettings,
  MODEL_SETTING_FIELDS,
  PROJECT_DYNAMIC_LIMITS,
  withoutModelFields,
  type ProjectDynamicOverrides,
  type ProjectDynamicPatch,
  type ProjectDynamicSettingField,
  type ProjectDynamicSettings,
  type ReviewVerdictMode,
  type ProjectReviewKind,
  type ReadableReviewSettings,
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
  type ReviewSettingWarning,
} from "./validate.ts";

/** The key of the global defaults in `app_settings`. */
export const REVIEW_DEFAULTS_KEY = "review_defaults";

/** The sources of the settings; the model fields are absent for a workspace on the operator's key (#283). */
export type ReadableSources = Omit<
  Record<ReviewSettingField, SettingSource>,
  (typeof MODEL_SETTING_FIELDS)[number]
> &
  Partial<
    Pick<
      Record<ReviewSettingField, SettingSource>,
      (typeof MODEL_SETTING_FIELDS)[number]
    >
  >;

type ViewBase = {
  /** The fields this layer sets; every other field is inherited. */
  overrides: ReviewSettingsOverrides;
  /** The settings a review uses at this level; without the model fields for a workspace on the operator's key. */
  effective: ReadableReviewSettings;
  /** Where each field of `effective` comes from; without the model fields for a workspace on the operator's key. */
  sources: ReadableSources;
  /**
   * What a review is expected to cost with these settings, and whether that is above the limit. `null` for a workspace
   * on the operator's key: the estimate is for a model that workspace does not know and that is not used (#283).
   */
  cost: ReviewCostGuard | null;
  /**
   * The models of this workspace's reviews are the operator's (its key mode is `managed`): the workspace chooses a
   * quality level (`modelTier`) and the view carries no model field, no Dynamic model and no cost (#283).
   */
  modelManagedByInstance: boolean;
  /**
   * For such a workspace, whether each level has a model for each kind of review: yes or no, never which model.
   * `null` for every other workspace.
   */
  tierAvailability: TierAvailability | null;
};

export type GlobalSettingsView = ViewBase & {
  /** The values nobody changed. */
  builtIn: ReadableReviewSettings;
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
  inherited: ReadableReviewSettings;
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
    /** Absent for a workspace on the operator's key (#283). */
    dynamicModel?: string;
    /** The text a Dynamic review uses: the project's override, else the shipped default. */
    reviewSkill: string;
    /** What a finished review does on its pull request besides the check run (#405). */
    reviewVerdict: ReviewVerdictMode;
  };
  /** Where each effective value comes from (there is no global layer for these fields). */
  sources: Partial<Record<"dynamicModel", "built_in" | "project">> &
    Record<
      Exclude<ProjectDynamicSettingField, "dynamicModel">,
      "built_in" | "project"
    >;
  /** What applies when the project sets nothing. */
  defaults: {
    reviewKind: ProjectReviewKind;
    /** Absent for a workspace on the operator's key (#283). */
    dynamicModel?: string;
    reviewSkill: string;
    reviewVerdict: ReviewVerdictMode;
  };
  /** Whether the effective skill is the shipped default (the project sets no override). */
  reviewSkillIsDefault: boolean;
  /** The identity of the shipped default skill (the seam #198 replaces with the attributed asset). */
  defaultSkill: { id: string; version: string; hash: string };
  /** The bounds an override is held to. */
  limits: { reviewSkillMaxBytes: number };
};

/** The answer of a project save: the new view and the notes on it (#269). */
export type ProjectSettingsSaved = ProjectSettingsView & {
  /** Notes on a save that went through, for example a Dynamic model that could not be checked. */
  warnings: ReviewSettingWarning[];
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
   * A Dynamic model that is set is checked against the provider's model metadata first (#269): one
   * without tool calling or an unknown one is refused, one that cannot be checked is accepted with a
   * warning. Throws `REVIEW_SETTINGS_INVALID` or `REVIEW_SETTINGS_PROJECT_NOT_FOUND`.
   */
  updateProjectSettings(
    repositoryId: string,
    input: unknown,
  ): Promise<ProjectSettingsSaved>;
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

/** The model fields a layer holds, to carry through a save that cannot set them (#283). */
function modelFieldsOf(
  layer: ReviewSettingsOverrides,
): ReviewSettingsOverrides {
  const kept: ReviewSettingsOverrides = {};
  if (layer.model !== undefined) kept.model = layer.model;
  if (layer.fallbackModel !== undefined)
    kept.fallbackModel = layer.fallbackModel;
  return kept;
}

/**
 * A write from a workspace on the operator's key may not set a model field: the models are the operator's (#283).
 * Judged on the names the request carries, before any value is looked at, so a model that is also malformed is
 * refused for the reason that matters. Every such field is named, not only the first.
 */
function refuseModelFields(input: unknown, fields: readonly string[]): void {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return;
  const issues: ReviewSettingIssue[] = Object.keys(input)
    .filter((name) => fields.includes(name))
    .map((field) => ({ field, code: "MODEL_MANAGED_BY_INSTANCE" }));
  if (issues.length > 0)
    throw new ReviewSettingsError(
      "REVIEW_SETTINGS_INVALID",
      "Some settings are not valid.",
      issues,
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
 * The settings a project save stores.
 *
 * - The **Diff group** is replaced as a whole when the request carries any Diff field (a field left
 *   out is inherited again). A request that only carries project-only fields keeps the stored Diff
 *   group, so switching kind, changing the Dynamic model or resetting the skill removes nothing of
 *   the Diff configuration. An empty request still replaces the Diff group with nothing (the
 *   "Use default" of every Diff field).
 * - The **project-only fields** are merged over the stored ones, so a save that does not know them
 *   (an older client) keeps them. A `reviewSkill` or `dynamicModel` of `null` clears that override and
 *   resolves to the built-in value again (#194, #200).
 */
function mergeProjectSettings(
  current: ProjectSettings,
  patch: ProjectSettingsPatch,
): ProjectSettings {
  const hasDiffFields = Object.keys(patch.review).length > 0;
  const hasProjectFields = Object.keys(patch.dynamic).length > 0;
  // A project-only request (project fields, no Diff field) never touches the Diff group; anything
  // else replaces it, including an empty request (every Diff override cleared).
  const review =
    hasProjectFields && !hasDiffFields
      ? parseStoredOverrides(current)
      : patch.review;

  const storedDynamic = parseStoredProjectDynamicOverrides(current);
  const dynamic: ProjectDynamicPatch = {
    ...storedDynamic,
    ...patch.dynamic,
  };

  const next: ProjectSettings = { ...review };
  if (dynamic.reviewKind !== undefined) next.reviewKind = dynamic.reviewKind;
  if (dynamic.dynamicModel !== undefined) {
    // A `null` model is an explicit "follow the built-in default again", not a value.
    if (dynamic.dynamicModel === null) delete next.dynamicModel;
    else next.dynamicModel = dynamic.dynamicModel;
  }
  if (dynamic.reviewSkill !== undefined && dynamic.reviewSkill !== null)
    next.reviewSkill = dynamic.reviewSkill;
  // A `null` verdict mode is an explicit "follow the default again" (#405).
  if (dynamic.reviewVerdict !== undefined && dynamic.reviewVerdict !== null)
    next.reviewVerdict = dynamic.reviewVerdict;
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
  /**
   * Checks the Dynamic model of a project save (#269). Without it nothing is checked, which is what a
   * test of another behavior wants; the running server always passes the real one.
   */
  modelCapabilities?: ModelCapabilityChecker;
  /**
   * Whether the models of this workspace's reviews are the operator's, not its own (its key mode is `managed`, #280).
   * Then the workspace does not know the model, so its token budget is not checked against the context window of
   * the stored model, which does not apply (the claim clamps the budget to the window of the tier's model). Default:
   * never.
   */
  operatorsModels?: () => Promise<boolean>;
  /**
   * Whether each quality level has a model for each kind of review, for the quality choice of a workspace on the
   * operator's key (#283). Only that: never which model. Default: nothing is configured.
   */
  tierAvailability?: () => Promise<TierAvailability>;
}): ReviewSettingsService {
  const { appSettings, projects } = deps;
  const dynamicDefaults =
    deps.dynamicDefaults ?? (() => builtInProjectDynamicSettings());
  const defaultSkill = deps.defaultSkill ?? readDefaultReviewSkill;
  const hooks = deps.hooks ?? noopReviewSettingsHooks;
  const operatorsModels = deps.operatorsModels ?? (async () => false);
  const tierAvailability =
    deps.tierAvailability ?? (async () => configuredTiers({}));

  async function readGlobal() {
    const stored = await appSettings.get(REVIEW_DEFAULTS_KEY);
    return {
      overrides: parseStoredOverrides(stored?.value),
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: stored?.updatedBy ?? null,
    };
  }

  /** The effective review kind of a stored settings object (Diff Review when none is set). */
  function kindOf(settings: ProjectSettings): ProjectReviewKind {
    return parseStoredProjectDynamicOverrides(settings).reviewKind ?? "diff";
  }

  async function viewOf(
    effective: EffectiveReviewSettings,
    overrides: ReviewSettingsOverrides,
  ): Promise<ViewBase> {
    // A workspace on the operator's key does not know the model, so none of the views carries one, and the estimate
    // is for a model it does not use.
    if (await operatorsModels())
      return {
        overrides: withoutModelFields(overrides),
        effective: withoutModelFields(effective.settings),
        sources: withoutModelFields(effective.sources),
        cost: null,
        modelManagedByInstance: true,
        tierAvailability: await tierAvailability(),
      };
    return {
      overrides,
      effective: effective.settings,
      sources: effective.sources,
      cost: estimateReviewCost(effective.settings),
      modelManagedByInstance: false,
      tierAvailability: null,
    };
  }

  /** The project-only settings of a project, with their sources, defaults and limits. */
  function dynamicView(
    project: StoredProject | undefined,
    managed: boolean,
  ): ProjectDynamicView {
    const defaults = dynamicDefaults();
    const shipped = defaultSkill();
    const overrides = parseStoredProjectDynamicOverrides(project?.settings);
    const effective = resolveProjectDynamicSettings({
      builtIn: defaults,
      project: overrides,
      defaultSkill: shipped.text,
    });
    const view: ProjectDynamicView = {
      overrides,
      effective: {
        reviewKind: effective.reviewKind,
        dynamicModel: effective.dynamicModel,
        reviewSkill: effective.reviewSkill,
        reviewVerdict: effective.reviewVerdict,
      },
      sources: effective.sources,
      defaults: {
        reviewKind: defaults.reviewKind,
        dynamicModel: defaults.dynamicModel,
        reviewSkill: shipped.text,
        reviewVerdict: defaults.reviewVerdict,
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
    if (!managed) return view;
    // The Dynamic model is the operator's as well (#283).
    const storedOverrides = { ...view.overrides };
    const shownEffective = { ...view.effective };
    const shownDefaults = { ...view.defaults };
    const shownSources = { ...view.sources };
    delete storedOverrides.dynamicModel;
    delete shownEffective.dynamicModel;
    delete shownDefaults.dynamicModel;
    delete shownSources.dynamicModel;
    return {
      ...view,
      overrides: storedOverrides,
      effective: shownEffective,
      defaults: shownDefaults,
      sources: shownSources,
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
      ...(await viewOf(effective, global.overrides)),
      builtIn: (await operatorsModels())
        ? withoutModelFields(builtIn)
        : builtIn,
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
    const managed = await operatorsModels();
    const inherited = resolveReviewSettings({ builtIn, global }).settings;
    return {
      ...(await viewOf(effective, overrides)),
      repositoryId,
      projectId: project?.id ?? null,
      active: project?.active ?? false,
      inherited: managed ? withoutModelFields(inherited) : inherited,
      dynamic: dynamicView(project, managed),
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

  /**
   * Asks the provider whether the Dynamic model of a save supports tool calling. Only a model that this
   * request sets is asked about: a cleared model (`null`), a request without one and a value that is already
   * stored are left alone (#269-T09).
   */
  async function checkDynamicModel(
    model: string | null | undefined,
  ): Promise<ReviewSettingWarning[]> {
    if (typeof model !== "string" || deps.modelCapabilities === undefined)
      return [];
    const result = await deps.modelCapabilities.check(model);
    switch (result.outcome) {
      case "supported":
        return [];
      case "unverifiable":
        return [{ field: "dynamicModel", code: "DYNAMIC_MODEL_UNVERIFIED" }];
      case "unsupported":
      case "unknown_model":
        throw new ReviewSettingsError(
          "REVIEW_SETTINGS_INVALID",
          "Some settings are not valid.",
          [
            {
              field: "dynamicModel",
              code:
                result.outcome === "unsupported"
                  ? "DYNAMIC_MODEL_TOOLS_UNSUPPORTED"
                  : "DYNAMIC_MODEL_UNKNOWN",
            },
          ],
        );
    }
  }

  return {
    getGlobalSettings: globalView,

    async updateGlobalSettings(input, actor) {
      const managed = await operatorsModels();
      if (managed) refuseModelFields(input, MODEL_SETTING_FIELDS);
      const requested = checked(input);
      // The models a workspace saved on its own key stay stored (it can go back to it); a save that cannot set them
      // does not drop them.
      const overrides = managed
        ? { ...requested, ...modelFieldsOf((await readGlobal()).overrides) }
        : requested;
      if (!managed)
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
      const managed = await operatorsModels();
      if (managed)
        refuseModelFields(input, [...MODEL_SETTING_FIELDS, "dynamicModel"]);
      const patch = checkedProject(input);
      const warnings = await checkDynamicModel(patch.dynamic.dynamicModel);
      if (!managed)
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
          const merged = mergeProjectSettings(current, patch);
          // The models saved on the workspace's own key stay stored (see the global defaults).
          const next = managed
            ? { ...merged, ...modelFieldsOf(parseStoredOverrides(current)) }
            : merged;
          previousKind = kindOf(current);
          kindChanged = previousKind !== kindOf(next);
          return next;
        },
        async (updated, executor) => {
          await hooks.onProjectSettingsChanged(
            {
              projectId: updated.id,
              repositoryId: updated.repositoryId,
              previousKind,
              nextKind: kindOf(updated.settings),
              kindChanged,
            },
            executor,
          );
        },
      );
      if (project === undefined) throw notFound();
      return { ...(await projectView(repositoryId, project)), warnings };
    },

    async resetProjectSettings(repositoryId) {
      // Nothing to remove, so no row is created just for this.
      if ((await projects.get(repositoryId)) === undefined)
        return viewOfRepository(repositoryId);
      // A full reset clears every override (Diff and project-only) and notifies the same hook as a
      // save, so a kind change back to Diff cancels waiting reviews and a rejecting hook rolls the
      // reset back.
      const managed = await operatorsModels();
      let previousKind: ProjectReviewKind = "diff";
      const project = await projects.updateSettingsWith(
        repositoryId,
        (current) => {
          previousKind = kindOf(current);
          // The models saved on the workspace's own key stay stored, as they do through a save (#283).
          if (!managed) return {};
          const kept: ProjectSettings = modelFieldsOf(
            parseStoredOverrides(current),
          );
          const storedModel =
            parseStoredProjectDynamicOverrides(current).dynamicModel;
          if (storedModel !== undefined) kept.dynamicModel = storedModel;
          return kept;
        },
        async (updated, executor) => {
          const nextKind = kindOf(updated.settings);
          await hooks.onProjectSettingsChanged(
            {
              projectId: updated.id,
              repositoryId: updated.repositoryId,
              previousKind,
              nextKind,
              kindChanged: previousKind !== nextKind,
            },
            executor,
          );
        },
      );
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
