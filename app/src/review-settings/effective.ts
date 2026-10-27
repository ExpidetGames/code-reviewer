// SPDX-License-Identifier: LicenseRef-Proprietary

// Puts the layers together: built-in values, global defaults, project overrides. Pure.
import type { ReviewCommand } from "../integrations/types.ts";
import {
  REVIEW_SETTING_FIELDS,
  type ProjectDynamicOverrides,
  type ProjectDynamicSettingField,
  type ReviewSettingField,
  type ReviewSettings,
  type ReviewSettingsOverrides,
  type ReviewVerdictMode,
} from "./settings.ts";
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";

/** Where the value of a field comes from. */
export type SettingSource = "built_in" | "global" | "project";

export type EffectiveReviewSettings = {
  settings: ReviewSettings;
  sources: Record<ReviewSettingField, SettingSource>;
};

function copyValue<K extends ReviewSettingField>(
  value: ReviewSettings[K],
): ReviewSettings[K] {
  return Array.isArray(value) ? ([...value] as ReviewSettings[K]) : value;
}

/**
 * The settings a review of one project uses: the project's value for a field it overrides, else the
 * global default if one was set, else the built-in value. The result shares nothing with its inputs.
 */
export function resolveReviewSettings(layers: {
  builtIn: ReviewSettings;
  global?: ReviewSettingsOverrides;
  project?: ReviewSettingsOverrides;
}): EffectiveReviewSettings {
  const settings: ReviewSettings = { ...layers.builtIn };
  const sources = {} as Record<ReviewSettingField, SettingSource>;

  function resolveField<K extends ReviewSettingField>(field: K): void {
    let value: ReviewSettings[K] = layers.builtIn[field];
    let source: SettingSource = "built_in";
    const globalValue = layers.global?.[field];
    if (globalValue !== undefined) {
      value = globalValue;
      source = "global";
    }
    const projectValue = layers.project?.[field];
    if (projectValue !== undefined) {
      value = projectValue;
      source = "project";
    }
    settings[field] = copyValue(value);
    sources[field] = source;
  }
  for (const field of REVIEW_SETTING_FIELDS) resolveField(field);

  return { settings, sources };
}

/**
 * Where a kind, Dynamic model, skill or verdict comes from: the shipped default, the workspace default (#676) or the
 * project itself.
 */
export type ProjectDynamicSource = SettingSource;

export type EffectiveProjectDynamic = {
  reviewKind: ProjectReviewKind;
  dynamicModel: string;
  /** The provider of `dynamicModel`; the default provider unless the project chose one (#430). */
  dynamicProvider: string;
  /** The catalog entry the project selects per kind, or null for none (#430). */
  catalogEntryDiff: string | null;
  catalogEntryDynamic: string | null;
  /** The skill text a Dynamic review uses: the project's override, else the shipped default. */
  reviewSkill: string;
  /** Whether `reviewSkill` is the shipped default (the project sets no override). */
  reviewSkillIsDefault: boolean;
  /** What a finished review does on its pull request besides the check run (#405). */
  reviewVerdict: ReviewVerdictMode;
  sources: Record<ProjectDynamicSettingField, ProjectDynamicSource>;
};

/**
 * The kind, Dynamic model, verdict and skill of one project (#194): the project's value, else the workspace default (#676),
 * else the shipped default, like every other setting; the skill has no workspace default. `builtIn.reviewSkill` is always null; `defaultSkill` is the text of the shipped
 * skill the app and the runner share. Switching kinds changes nothing about the other values: each kind keeps its own model
 * and skill.
 */
export function resolveProjectDynamicSettings(layers: {
  builtIn: {
    reviewKind: ProjectReviewKind;
    dynamicModel: string;
    dynamicProvider: string;
    catalogEntryDiff: string | null;
    catalogEntryDynamic: string | null;
    reviewSkill: string | null;
    reviewVerdict: ReviewVerdictMode;
  };
  /** What the workspace sets for all its projects (#676); only the fields somebody set, never the skill. */
  workspace?: Omit<ProjectDynamicOverrides, "reviewSkill">;
  project?: ProjectDynamicOverrides;
  defaultSkill: string;
}): EffectiveProjectDynamic {
  const { builtIn, workspace, project } = layers;
  const sourceOf = (
    field: ProjectDynamicSettingField,
  ): ProjectDynamicSource => {
    if (project?.[field] !== undefined) return "project";
    if (field !== "reviewSkill" && workspace?.[field] !== undefined)
      return "global";
    return "built_in";
  };

  const sources = {} as Record<
    ProjectDynamicSettingField,
    ProjectDynamicSource
  >;
  for (const field of [
    "reviewKind",
    "dynamicModel",
    "dynamicProvider",
    "catalogEntryDiff",
    "catalogEntryDynamic",
    "reviewVerdict",
  ] as const)
    sources[field] = sourceOf(field);
  // The skill has no workspace default (#676): the project's text, else the shipped one. A null (or empty, already
  // normalized to null) override means "no override" and resolves to the shipped default, never to another project's skill.
  const reviewSkillOverride = project?.reviewSkill ?? null;
  const reviewSkillIsDefault = reviewSkillOverride === null;
  sources.reviewSkill = reviewSkillIsDefault ? "built_in" : "project";

  return {
    reviewKind:
      project?.reviewKind ?? workspace?.reviewKind ?? builtIn.reviewKind,
    dynamicModel:
      project?.dynamicModel ?? workspace?.dynamicModel ?? builtIn.dynamicModel,
    dynamicProvider:
      project?.dynamicProvider ??
      workspace?.dynamicProvider ??
      builtIn.dynamicProvider,
    catalogEntryDiff:
      project?.catalogEntryDiff ??
      workspace?.catalogEntryDiff ??
      builtIn.catalogEntryDiff,
    catalogEntryDynamic:
      project?.catalogEntryDynamic ??
      workspace?.catalogEntryDynamic ??
      builtIn.catalogEntryDynamic,
    reviewSkill: reviewSkillOverride ?? layers.defaultSkill,
    reviewSkillIsDefault,
    reviewVerdict:
      project?.reviewVerdict ??
      workspace?.reviewVerdict ??
      builtIn.reviewVerdict,
    sources,
  };
}

/** What starts a review without a person asking: a pull request opened, or new commits pushed. */
export type AutomaticTrigger = "opened" | "updated";

/**
 * Whether the settings let a trigger start a review. The webhook intake asks this for `opened`
 * (opened, reopened, ready for review) and `updated` (push). PR-Agent itself never starts anything
 * on its own here (the app is the only trigger), so nothing about triggers goes to the runner.
 */
export function isAutomaticReviewEnabled(
  settings: ReviewSettings,
  trigger: AutomaticTrigger,
): boolean {
  return trigger === "opened"
    ? settings.autoReviewOnOpen
    : settings.autoReviewOnPush;
}

/** Whether a comment command may be used in this project. */
export function isCommandAllowed(
  settings: ReviewSettings,
  command: ReviewCommand,
): boolean {
  return settings.allowedCommands.includes(command);
}
