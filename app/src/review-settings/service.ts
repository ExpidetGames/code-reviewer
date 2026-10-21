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
import type { LlmProvider } from "../llm/config.ts";
import { modelProviderMismatch, type ModelLayer } from "../llm/selection.ts";
import type { ModelCapabilityChecker } from "../llm/model-capabilities.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import {
  catalogChoices,
  refusalOfChoice,
  type CatalogChoices,
  type CatalogSelection,
  type CatalogSelectionSource,
} from "./catalog-selection.ts";
import {
  dynamicModelToCheck,
  type DynamicModelCheck,
} from "./dynamic-check.ts";
import { isNativeProvider, nativeDynamicChoice } from "./native-choice.ts";
import type { NativeSelectionSource } from "../native-providers/catalog.ts";
import {
  pinAfterSave,
  pinMoveNeedsRight,
  providerAddressView,
  type ProviderAddressView,
} from "./provider-pin.ts";
import { createPinnedAddressReader } from "./pinned-addresses.ts";
import { ReviewSettingsError } from "./errors.ts";
import type { ReviewSettingsHooks } from "./hooks.ts";
import { noopReviewSettingsHooks } from "./hooks.ts";
import {
  builtInProjectDynamicSettings,
  CATALOG_FIELD_OF_KIND,
  MODEL_SETTING_FIELDS,
  PROJECT_CATALOG_FIELDS,
  PROJECT_DYNAMIC_LIMITS,
  PROJECT_REVIEW_KINDS,
  withoutModelFields,
  type ProjectCatalogField,
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
  type ProviderLookup,
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
   * catalog entry per project and the view carries no model field, no Dynamic model and no cost (#283, #433).
   */
  modelManagedByInstance: boolean;
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
  /**
   * For a workspace on the operator's key (#430): the entries it may pick from per kind, with an id, a name, a
   * description, whether each can be chosen and why not. Never a provider or a model. `null` on its own key.
   */
  catalogChoices: CatalogChoices | null;
  /** The entry the project selects per kind (`null`: none, the instance default applies), or `null` on its own key. */
  catalogSelection: CatalogSelection | null;
};

/**
 * The project-only settings as a reader sees them (#194): the kind, the Dynamic model and the skill,
 * each with where it comes from, the shipped default it falls back to, and the size limit of an
 * override.
 */
export type ProjectDynamicView = {
  /**
   * The project-only fields this project sets. The catalog entries are not here: they are `catalogSelection` of the
   * project view, and only for a workspace on the operator's key (#430).
   */
  overrides: Omit<
    ProjectDynamicOverrides,
    ProjectCatalogField | "dynamicProviderAddress"
  >;
  /**
   * The address pinned for the project's catalog provider and what the catalog trusts for it now (#588); `null` when the
   * project selects no catalog provider, and for a workspace on the operator's key.
   */
  providerAddress?: ProviderAddressView | null;
  /** The kind, Dynamic model and skill a review would use. */
  effective: {
    reviewKind: ProjectReviewKind;
    /** Absent for a workspace on the operator's key (#283). */
    dynamicModel?: string;
    /** The provider of the Dynamic model; absent for a workspace on the operator's key (#430). */
    dynamicProvider?: string;
    /** The text a Dynamic review uses: the project's override, else the shipped default. */
    reviewSkill: string;
    /** What a finished review does on its pull request besides the check run (#405). */
    reviewVerdict: ReviewVerdictMode;
  };
  /** Where each effective value comes from (there is no global layer for these fields). */
  sources: Partial<
    Record<"dynamicModel" | "dynamicProvider", "built_in" | "project">
  > &
    Record<
      Exclude<
        ProjectDynamicSettingField,
        "dynamicModel" | "dynamicProvider" | ProjectCatalogField
      >,
      "built_in" | "project"
    >;
  /** What applies when the project sets nothing. */
  defaults: {
    reviewKind: ProjectReviewKind;
    /** Absent for a workspace on the operator's key (#283). */
    dynamicModel?: string;
    /** Absent for a workspace on the operator's key (#430). */
    dynamicProvider?: string;
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

/**
 * Who saves, as far as the pinned address of a catalog provider is concerned (#588): writing a pin another project of the workspace
 * does not hold, and dropping or replacing a pin the catalog no longer trusts, are for the roles that manage the workspace's LLM
 * key. Left out, the actor may not (fails closed).
 */
export type ProjectSaveActor = { canManageLlmKey: boolean };

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
    actor?: ProjectSaveActor,
  ): Promise<ProjectSettingsSaved>;
  /**
   * Removes every override of a project, so it follows the global defaults again. A repository
   * without a project has none to remove: nothing is written.
   */
  resetProjectSettings(
    repositoryId: string,
    actor?: ProjectSaveActor,
  ): Promise<ProjectSettingsView>;
  /**
   * The claim of a job on a selection made before pins existed (#588): pins `address`, the one the claim is about to send the key
   * to, unless the project has a pin already or another project of the workspace pinned another address for the provider. Answers
   * the pin in force (that other pin when it is the reason nothing was written), so a claim that lost a race to another pin holds
   * to that one; null when the project no longer selects `provider` (a raced settings change).
   */
  adoptProviderAddress(
    repositoryId: string,
    provider: string,
    address: string,
  ): Promise<string | null>;
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

/**
 * The layers a model is resolved from for each kind (#432): what the workspace default and the project wrote, apart,
 * with a field no layer set left out. The claim of a workspace on its own key hands them to `resolveModelSelection`,
 * which pairs a model with the provider it was set for; the merged settings cannot say that.
 */
export type ResolvedModelLayers = {
  diff: { workspace: ModelLayer; project: ModelLayer };
  /** The Dynamic model and provider are project-only fields (#194): there is no workspace layer. */
  dynamic: { project: ModelLayer };
};

/** The Diff settings of a project plus its project-only kind, model and skill (#194). */
export type ResolvedProjectSettings = EffectiveReviewSettings & {
  dynamic: EffectiveProjectDynamic;
  modelLayers: ResolvedModelLayers;
};

function notFound(): ReviewSettingsError {
  return new ReviewSettingsError(
    "REVIEW_SETTINGS_PROJECT_NOT_FOUND",
    "There is no such repository.",
  );
}

/** The provider and model a Diff layer wrote; a field it left out is not in the result. */
function diffLayerOf(layer: ReviewSettingsOverrides): ModelLayer {
  return {
    ...(layer.provider === undefined ? {} : { provider: layer.provider }),
    ...(layer.model === undefined ? {} : { model: layer.model }),
  };
}

/** The provider and model of the project's Dynamic settings; a field it left out is not in the result. */
function dynamicLayerOf(layer: ProjectDynamicOverrides): ModelLayer {
  return {
    ...(layer.dynamicProvider == null
      ? {}
      : { provider: layer.dynamicProvider }),
    ...(layer.dynamicModel == null ? {} : { model: layer.dynamicModel }),
    ...(layer.dynamicProviderAddress === undefined
      ? {}
      : { address: layer.dynamicProviderAddress }),
  };
}

/** The model fields (and the provider they belong to) a layer holds, to carry through a save that cannot set them (#283, #430). */
function modelFieldsOf(
  layer: ReviewSettingsOverrides,
): ReviewSettingsOverrides {
  const kept: ReviewSettingsOverrides = {};
  if (layer.provider !== undefined) kept.provider = layer.provider;
  if (layer.model !== undefined) kept.model = layer.model;
  if (layer.fallbackModel !== undefined)
    kept.fallbackModel = layer.fallbackModel;
  return kept;
}

/** The Dynamic model and provider a project holds, to carry through a save or a reset that cannot set them (#283, #430). */
function dynamicModelFieldsOf(
  layer: ProjectDynamicOverrides,
): ProjectDynamicOverrides {
  const kept: ProjectDynamicOverrides = {};
  if (layer.dynamicModel !== undefined) kept.dynamicModel = layer.dynamicModel;
  if (layer.dynamicProvider !== undefined)
    kept.dynamicProvider = layer.dynamicProvider;
  // The pin belongs to the provider it was made for and travels with it (#588).
  if (layer.dynamicProviderAddress !== undefined)
    kept.dynamicProviderAddress = layer.dynamicProviderAddress;
  return kept;
}

/** The catalog entries a project holds, to carry through a reset of a workspace on its own key (#430). */
function catalogFieldsOf(layer: ProjectDynamicOverrides): ProjectSettings {
  const kept: ProjectSettings = {};
  for (const field of PROJECT_CATALOG_FIELDS) {
    const entry = layer[field];
    if (typeof entry === "string") kept[field] = entry;
  }
  return kept;
}

/** The pin is the server's: the view shows it as `providerAddress`, never as an override a client could send back. */
function withoutServerFields<T extends { dynamicProviderAddress?: unknown }>(
  layer: T,
): Omit<T, "dynamicProviderAddress"> {
  const copy = { ...layer };
  delete copy.dynamicProviderAddress;
  return copy;
}

function withoutCatalogFields<
  T extends Partial<Record<ProjectCatalogField, unknown>>,
>(layer: T): Omit<T, ProjectCatalogField> {
  const copy = { ...layer };
  for (const field of PROJECT_CATALOG_FIELDS) delete copy[field];
  return copy;
}

/**
 * A workspace on its own key never reads the catalog, so it may not select an entry (#430-T06): the write is refused
 * rather than stored unchecked. Judged on the names the request carries, before any value is looked at; `null`
 * clears a selection stored earlier and needs no catalog.
 */
function refuseCatalogEntries(input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return;
  const issues: ReviewSettingIssue[] = Object.entries(input)
    .filter(
      ([name, value]) =>
        (PROJECT_CATALOG_FIELDS as readonly string[]).includes(name) &&
        value !== null,
    )
    .map(([field]) => ({ field, code: "CATALOG_ENTRY_OWN_KEY_MODE" }));
  if (issues.length > 0)
    throw new ReviewSettingsError(
      "REVIEW_SETTINGS_INVALID",
      "Some settings are not valid.",
      issues,
    );
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

/**
 * The pairing of a model with a provider of another layer (a workspace model next to a project provider) is refused when
 * it is saved, with the rule of the claim (#432). `field` is the field the user changed.
 */
function refuseModelProviderMismatch(
  field: "provider" | "model",
  workspace: ReviewSettingsOverrides,
  project: ReviewSettingsOverrides,
  defaultProvider: string,
): void {
  if (
    !modelProviderMismatch(
      diffLayerOf(workspace),
      diffLayerOf(project),
      defaultProvider,
    )
  )
    return;
  throw new ReviewSettingsError(
    "REVIEW_SETTINGS_INVALID",
    "Some settings are not valid.",
    [{ field, code: "MODEL_PROVIDER_MISMATCH" }],
  );
}

function checked(
  input: unknown,
  providers: ProviderLookup,
): ReviewSettingsOverrides {
  const result = validateReviewSettingsPatch(input, providers);
  if (!result.ok)
    throw new ReviewSettingsError(
      "REVIEW_SETTINGS_INVALID",
      "Some settings are not valid.",
      result.issues,
    );
  return result.value;
}

/** Validates the Diff and project-only fields of a project save (#194). */
function checkedProject(
  input: unknown,
  providers: ProviderLookup,
): ProjectSettingsPatch {
  const result = validateProjectSettingsPatch(input, providers);
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
  providers: ProviderLookup,
  /** The address the catalog trusts for the provider the project has after the save, when it is a catalog provider (#588). */
  trusted: { provider: string; address: string } | undefined,
): ProjectSettings {
  const hasDiffFields = Object.keys(patch.review).length > 0;
  const hasProjectFields = Object.keys(patch.dynamic).length > 0;
  // A project-only request (project fields, no Diff field) never touches the Diff group; anything
  // else replaces it, including an empty request (every Diff override cleared).
  const review =
    hasProjectFields && !hasDiffFields
      ? parseStoredOverrides(current, providers)
      : patch.review;

  const storedDynamic = parseStoredProjectDynamicOverrides(current, providers);
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
  // A `null` provider or catalog entry is an explicit "follow the default again" (#430).
  if (dynamic.dynamicProvider !== undefined && dynamic.dynamicProvider !== null)
    next.dynamicProvider = dynamic.dynamicProvider;
  // #588: the address of the catalog provider, written when it is selected or confirmed and kept otherwise.
  const nextProvider =
    typeof next.dynamicProvider === "string" ? next.dynamicProvider : undefined;
  const pin = pinAfterSave({
    nextProvider,
    storedProvider: storedDynamic.dynamicProvider,
    storedPin: storedDynamic.dynamicProviderAddress,
    native: nextProvider !== undefined && isNativeProvider(nextProvider),
    // Read before the transaction for the provider the request implied; a provider that changed meanwhile has no address here.
    trusted:
      trusted !== undefined && trusted.provider === nextProvider
        ? trusted.address
        : undefined,
    confirm: patch.confirmProviderAddress === true,
  });
  if (pin !== undefined) next.dynamicProviderAddress = pin;
  for (const field of PROJECT_CATALOG_FIELDS) {
    const entry = dynamic[field];
    if (typeof entry === "string") next[field] = entry;
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
   * the stored model, which does not apply (the claim clamps the budget to the window of the entry's model). Default:
   * never.
   */
  operatorsModels?: () => Promise<boolean>;
  /**
   * The model catalog as far as a project's selection needs it (#430): what the picker lists, whether an entry may be
   * chosen. Only read for a workspace on the operator's key. Default: an empty catalog.
   */
  catalog?: CatalogSelectionSource;
  /** Where a provider id is looked up; the registry of the app unless a test brings a second provider. */
  providers?: ProviderLookup;
  /**
   * The models.dev catalog as far as a save needs it (#555): whether a Dynamic provider that is a catalog provider has this
   * model listed. Only read for a workspace on its own key and a Dynamic provider outside the registry. Default: an empty
   * catalog, so such a choice is refused.
   */
  nativeCatalog?: NativeSelectionSource;
}): ReviewSettingsService {
  const { appSettings, projects } = deps;
  const dynamicDefaults =
    deps.dynamicDefaults ?? (() => builtInProjectDynamicSettings());
  const defaultSkill = deps.defaultSkill ?? readDefaultReviewSkill;
  const hooks = deps.hooks ?? noopReviewSettingsHooks;
  const operatorsModels = deps.operatorsModels ?? (async () => false);
  const providers = deps.providers ?? llmProviderDescriptors;
  // Without a catalog nothing can be chosen: every id is unknown and the picker is empty.
  const catalog: CatalogSelectionSource = deps.catalog ?? {
    entries: async () => [],
    find: async () => undefined,
    allowed: async () => false,
  };
  const parseReview = (stored: unknown) =>
    parseStoredOverrides(stored, providers);
  const parseDynamic = (stored: unknown) =>
    parseStoredProjectDynamicOverrides(stored, providers);

  async function readGlobal() {
    const stored = await appSettings.get(REVIEW_DEFAULTS_KEY);
    return {
      overrides: parseReview(stored?.value),
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: stored?.updatedBy ?? null,
    };
  }

  /** The effective review kind of a stored settings object (Diff Review when none is set). */
  function kindOf(settings: ProjectSettings): ProjectReviewKind {
    return parseDynamic(settings).reviewKind ?? "diff";
  }

  /** The entry a stored project settings object selects per kind, `null` for none. */
  function catalogSelectionOf(stored: unknown): CatalogSelection {
    const overrides = parseDynamic(stored);
    const selection = {} as CatalogSelection;
    for (const kind of PROJECT_REVIEW_KINDS)
      selection[kind] = overrides[CATALOG_FIELD_OF_KIND[kind]] ?? null;
    return selection;
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
      };
    return {
      overrides,
      effective: effective.settings,
      sources: effective.sources,
      cost: estimateReviewCost(effective.settings),
      modelManagedByInstance: false,
    };
  }

  /** The project-only settings of a project, with their sources, defaults and limits. */
  function dynamicView(
    project: StoredProject | undefined,
    managed: boolean,
  ): ProjectDynamicView {
    const defaults = dynamicDefaults();
    const shipped = defaultSkill();
    const overrides = parseDynamic(project?.settings);
    const effective = resolveProjectDynamicSettings({
      builtIn: defaults,
      project: overrides,
      defaultSkill: shipped.text,
    });
    const view: ProjectDynamicView = {
      // The catalog entries are shown as the catalog view of the project, and only to a workspace that uses them.
      overrides: withoutServerFields(withoutCatalogFields(overrides)),
      providerAddress: null,
      effective: {
        reviewKind: effective.reviewKind,
        dynamicModel: effective.dynamicModel,
        dynamicProvider: effective.dynamicProvider,
        reviewSkill: effective.reviewSkill,
        reviewVerdict: effective.reviewVerdict,
      },
      sources: withoutCatalogFields(effective.sources),
      defaults: {
        reviewKind: defaults.reviewKind,
        dynamicModel: defaults.dynamicModel,
        dynamicProvider: defaults.dynamicProvider,
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
    // The Dynamic model and its provider are the operator's as well (#283, #430).
    const storedOverrides = { ...view.overrides };
    const shownEffective = { ...view.effective };
    const shownDefaults = { ...view.defaults };
    const shownSources = { ...view.sources };
    for (const field of ["dynamicModel", "dynamicProvider"] as const) {
      delete storedOverrides[field];
      delete shownEffective[field];
      delete shownDefaults[field];
      delete shownSources[field];
    }
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
    const overrides = parseReview(project?.settings);
    const effective = resolveReviewSettings({
      builtIn,
      global,
      project: overrides,
    });
    const managed = await operatorsModels();
    const inherited = resolveReviewSettings({ builtIn, global }).settings;
    // The catalog is read for a workspace on the operator's key only (#430-T06).
    const selection = catalogSelectionOf(project?.settings);
    return {
      ...(await viewOf(effective, overrides)),
      repositoryId,
      projectId: project?.id ?? null,
      active: project?.active ?? false,
      inherited: managed ? withoutModelFields(inherited) : inherited,
      dynamic: {
        ...dynamicView(project, managed),
        providerAddress: await providerAddressOf(project, managed),
      },
      catalogChoices: managed ? await catalogChoices(catalog, selection) : null,
      catalogSelection: managed ? selection : null,
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
   * Asks the provider whether the Dynamic model of a save supports tool calling, through the adapter of the provider
   * the project selected (#430). Only a model that this request sets, or whose provider it changes, is asked about: a
   * cleared model (`null`), a request without either and a value that is already stored are left alone (#269-T09).
   */
  async function checkDynamicModel(
    target: DynamicModelCheck | null,
  ): Promise<ReviewSettingWarning[]> {
    if (target === null || deps.modelCapabilities === undefined) return [];
    // The provider was validated against the registry (or comes from storage that was).
    const result = await deps.modelCapabilities.check(target.model, {
      provider: target.provider as LlmProvider,
    });
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

  /**
   * A Dynamic provider that is a catalog provider (#555) needs a model, and the pair must be in the catalog. The provider's
   * model metadata is not asked: the catalog is the list. A pair that is stored already and that this save does not touch is
   * left alone.
   */
  async function refuseUnfitNativeChoice(
    patch: ProjectDynamicPatch,
    stored: ProjectDynamicOverrides,
  ): Promise<void> {
    const choice = nativeDynamicChoice(patch, stored);
    if (choice === null || !choice.changed) return;
    const refuse = (code: ReviewSettingIssue["code"]): never => {
      throw new ReviewSettingsError(
        "REVIEW_SETTINGS_INVALID",
        "Some settings are not valid.",
        [{ field: "dynamicModel", code }],
      );
    };
    if (choice.model === null) refuse("EMPTY");
    const found =
      deps.nativeCatalog === undefined
        ? { ok: false }
        : await deps.nativeCatalog.checkSelection(
            choice.provider,
            choice.model ?? "",
          );
    if (!found.ok) refuse("MODEL_NOT_IN_CATALOG");
  }

  /**
   * The address the catalog trusts for the catalog provider a save leaves the project with (#588), read before the write. A
   * person who confirms the address needs one: the project must select a catalog provider that the catalog still offers.
   */
  async function trustedAddressFor(
    choice: { provider: string } | null,
    confirm: boolean,
  ): Promise<{ provider: string; address: string } | undefined> {
    const address =
      choice === null || deps.nativeCatalog === undefined
        ? undefined
        : await deps.nativeCatalog.addressOf(choice.provider);
    if (choice !== null && address !== undefined)
      return { provider: choice.provider, address };
    if (confirm)
      throw new ReviewSettingsError(
        "REVIEW_SETTINGS_INVALID",
        "Some settings are not valid.",
        [
          {
            field: "confirmProviderAddress",
            code: "PROVIDER_ADDRESS_NOT_PINNABLE",
          },
        ],
      );
    return undefined;
  }

  const pinnedAddresses = createPinnedAddressReader(projects);

  /** The address the catalog trusts now for a provider, when it is a catalog provider it offers. */
  async function trustedNow(
    provider: string | undefined,
  ): Promise<string | undefined> {
    if (
      provider === undefined ||
      !isNativeProvider(provider) ||
      deps.nativeCatalog === undefined
    )
      return undefined;
    return deps.nativeCatalog.addressOf(provider);
  }

  /**
   * #588: refuses a save that moves the pin of the project (writes one, drops one, replaces one) when it is not the pin's
   * business of an Owner or Admin (`pinMoveNeedsRight`). `before` is the settings the save found, `after` what it would store;
   * `read` is what was looked up before the transaction for the providers they name, and a provider that changed meanwhile has
   * nothing looked up, which the rule reads as "not trusted": refused.
   */
  function refuseUnauthorizedPinMove(
    before: ProjectSettings,
    after: ProjectSettings,
    read: {
      storedProvider: string | undefined;
      trustedForStored: string | undefined;
      nextProvider: string | undefined;
      otherPins: readonly string[];
    },
    actor: ProjectSaveActor | undefined,
  ): void {
    if (actor?.canManageLlmKey === true) return;
    const stored = parseDynamic(before);
    const next = parseDynamic(after);
    const sameStored = stored.dynamicProvider === read.storedProvider;
    const sameNext = next.dynamicProvider === read.nextProvider;
    if (
      pinMoveNeedsRight({
        storedPin: stored.dynamicProviderAddress,
        newPin: next.dynamicProviderAddress,
        trustedForStored: sameStored ? read.trustedForStored : undefined,
        otherPins: sameNext
          ? read.otherPins
          : next.dynamicProviderAddress === undefined
            ? []
            : [""],
      })
    )
      throw new ReviewSettingsError(
        "PROVIDER_ADDRESS_CONFIRM_FORBIDDEN",
        "Only an Owner or Admin may confirm the address of a provider.",
      );
  }

  /** What the settings page shows of the pinned address; null when the project selects no catalog provider or the workspace is managed. */
  async function providerAddressOf(
    project: StoredProject | undefined,
    managed: boolean,
  ): Promise<ProviderAddressView | null> {
    if (managed) return null;
    const stored = parseDynamic(project?.settings);
    if (
      stored.dynamicProvider === undefined ||
      !isNativeProvider(stored.dynamicProvider)
    )
      return null;
    const current =
      deps.nativeCatalog === undefined
        ? undefined
        : await deps.nativeCatalog.addressOf(stored.dynamicProvider);
    return providerAddressView(stored.dynamicProviderAddress, current);
  }

  /**
   * A workspace on the operator's key selects an entry of the catalog per kind (#430-T07): it must exist, be released,
   * serve the kind and be allowed by the plan. Every refused kind is named. `null` (clear) needs no check.
   */
  async function refuseUnfitEntries(patch: ProjectDynamicPatch): Promise<void> {
    const issues: ReviewSettingIssue[] = [];
    for (const kind of PROJECT_REVIEW_KINDS) {
      const field = CATALOG_FIELD_OF_KIND[kind];
      const id = patch[field];
      if (typeof id !== "string") continue;
      const code = await refusalOfChoice(catalog, kind, id);
      if (code !== null) issues.push({ field, code });
    }
    if (issues.length > 0)
      throw new ReviewSettingsError(
        "REVIEW_SETTINGS_INVALID",
        "Some settings are not valid.",
        issues,
      );
  }

  /**
   * A change of the workspace default may not newly pair the model it holds with a project's provider of another
   * provider (#432). A project that already had the pairing is not blamed again: the claim still fails its job closed, and
   * this save must not stay impossible for it.
   */
  async function refuseGlobalChangeBreakingProjects(
    before: ReviewSettingsOverrides,
    after: ReviewSettingsOverrides,
  ): Promise<void> {
    for (const entry of await projects.list()) {
      if (entry.project === null) continue;
      const project = parseReview(entry.project.settings);
      const wasMismatched = modelProviderMismatch(
        diffLayerOf(before),
        diffLayerOf(project),
        providers.defaultProvider.id,
      );
      if (wasMismatched) continue;
      refuseModelProviderMismatch(
        "model",
        after,
        project,
        providers.defaultProvider.id,
      );
    }
  }

  return {
    getGlobalSettings: globalView,

    async updateGlobalSettings(input, actor) {
      const managed = await operatorsModels();
      if (managed) refuseModelFields(input, MODEL_SETTING_FIELDS);
      const requested = checked(input, providers);
      // The models a workspace saved on its own key stay stored (it can go back to it); a save that cannot set them
      // does not drop them.
      const overrides = managed
        ? { ...requested, ...modelFieldsOf((await readGlobal()).overrides) }
        : requested;
      if (!managed) {
        refuseBudgetAboveContext(
          overrides,
          resolveReviewSettings({ builtIn: deps.builtIn(), global: overrides })
            .settings,
        );
        await refuseGlobalChangeBreakingProjects(
          (await readGlobal()).overrides,
          overrides,
        );
      }
      await appSettings.set(REVIEW_DEFAULTS_KEY, overrides, actor);
      return globalView();
    },

    async getProjectSettings(repositoryId) {
      return viewOfRepository(repositoryId);
    },

    async updateProjectSettings(repositoryId, input, actor) {
      const managed = await operatorsModels();
      if (managed)
        refuseModelFields(input, [
          ...MODEL_SETTING_FIELDS,
          "dynamicModel",
          "dynamicProvider",
        ]);
      else refuseCatalogEntries(input);
      const patch = checkedProject(input, providers);
      if (managed) await refuseUnfitEntries(patch.dynamic);
      const storedDynamic = parseDynamic(
        (await projects.get(repositoryId))?.settings,
      );
      if (!managed) await refuseUnfitNativeChoice(patch.dynamic, storedDynamic);
      const choice = managed
        ? null
        : nativeDynamicChoice(patch.dynamic, storedDynamic);
      const trusted = await trustedAddressFor(
        choice,
        patch.confirmProviderAddress === true,
      );
      // #588: what the rule of who may move the pin needs, looked up before the write.
      const pinRead = {
        storedProvider: storedDynamic.dynamicProvider,
        trustedForStored: await trustedNow(storedDynamic.dynamicProvider),
        nextProvider: choice?.provider,
        otherPins:
          choice === null
            ? []
            : await pinnedAddresses(choice.provider, {
                exceptRepositoryId: repositoryId,
              }),
      };
      const toCheck = dynamicModelToCheck(
        patch.dynamic,
        storedDynamic,
        providers.defaultProvider.id,
      );
      // The model of a catalog provider is vouched for by the catalog (above), not by metadata the provider serves.
      const warnings = await checkDynamicModel(
        toCheck !== null && isNativeProvider(toCheck.provider) ? null : toCheck,
      );
      if (!managed)
        refuseBudgetAboveContext(
          patch.review,
          resolveReviewSettings({
            builtIn: deps.builtIn(),
            global: (await readGlobal()).overrides,
            project: patch.review,
          }).settings,
        );
      const workspaceLayer = managed ? {} : (await readGlobal()).overrides;
      let previousKind: ProjectReviewKind = "diff";
      let kindChanged = false;
      const project = await projects.updateSettingsWith(
        repositoryId,
        (current) => {
          const merged = mergeProjectSettings(
            current,
            patch,
            providers,
            trusted,
          );
          // Own key mode only: a managed workspace selects an entry, not a provider and a model. A pairing the project
          // already had is not blamed again, as for a change of the workspace default.
          if (
            !managed &&
            !modelProviderMismatch(
              diffLayerOf(workspaceLayer),
              diffLayerOf(parseReview(current)),
              providers.defaultProvider.id,
            )
          )
            refuseModelProviderMismatch(
              "provider",
              workspaceLayer,
              parseReview(merged),
              providers.defaultProvider.id,
            );
          // The models saved on the workspace's own key stay stored (see the global defaults).
          const next = managed
            ? { ...merged, ...modelFieldsOf(parseReview(current)) }
            : merged;
          refuseUnauthorizedPinMove(current, next, pinRead, actor);
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

    async adoptProviderAddress(repositoryId, provider, address) {
      let inForce: string | null = null;
      // #588: an address that another project of the workspace did not pin for the provider is not adopted; the claim then holds
      // to that pin and is refused, and an Owner or Admin confirms the address.
      const others = isNativeProvider(provider)
        ? await pinnedAddresses(provider, { exceptRepositoryId: repositoryId })
        : [];
      const project = await projects.updateSettingsWith(
        repositoryId,
        (current) => {
          const stored = parseDynamic(current);
          if (
            stored.dynamicProvider !== provider ||
            !isNativeProvider(provider)
          ) {
            inForce = null;
            return current;
          }
          if (stored.dynamicProviderAddress !== undefined) {
            inForce = stored.dynamicProviderAddress;
            return current;
          }
          const other = others.find((pin) => pin !== address);
          if (other !== undefined) {
            inForce = other;
            return current;
          }
          inForce = address;
          return { ...current, dynamicProviderAddress: address };
        },
      );
      return project === undefined ? null : inForce;
    },

    async resetProjectSettings(repositoryId, actor) {
      // Nothing to remove, so no row is created just for this.
      const existing = await projects.get(repositoryId);
      if (existing === undefined) return viewOfRepository(repositoryId);
      const storedProvider = parseDynamic(existing.settings).dynamicProvider;
      const pinRead = {
        storedProvider,
        trustedForStored: await trustedNow(storedProvider),
        nextProvider: undefined,
        otherPins: [],
      };
      // A full reset clears every override (Diff and project-only) and notifies the same hook as a
      // save, so a kind change back to Diff cancels waiting reviews and a rejecting hook rolls the
      // reset back.
      const managed = await operatorsModels();
      let previousKind: ProjectReviewKind = "diff";
      const project = await projects.updateSettingsWith(
        repositoryId,
        (current) => {
          previousKind = kindOf(current);
          // What the other key mode stored stays stored, as it does through a save (#283, #430): the models and
          // providers of the workspace's own key while it is on the operator's key, and the other way round the
          // catalog entries it chose then.
          const next = !managed
            ? catalogFieldsOf(parseDynamic(current))
            : {
                ...modelFieldsOf(parseReview(current)),
                ...dynamicModelFieldsOf(parseDynamic(current)),
              };
          refuseUnauthorizedPinMove(current, next, pinRead, actor);
          return next;
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
      const globalOverrides = (await readGlobal()).overrides;
      const projectOverrides = parseReview(project.settings);
      const projectDynamic = parseDynamic(project.settings);
      const review = resolveReviewSettings({
        builtIn: deps.builtIn(),
        global: globalOverrides,
        project: projectOverrides,
      });
      const dynamic = resolveProjectDynamicSettings({
        builtIn: dynamicDefaults(),
        project: projectDynamic,
        defaultSkill: defaultSkill().text,
      });
      return {
        ...review,
        dynamic,
        modelLayers: {
          diff: {
            workspace: diffLayerOf(globalOverrides),
            project: diffLayerOf(projectOverrides),
          },
          dynamic: {
            project: dynamicLayerOf(projectDynamic),
          },
        },
      };
    },
  };
}
