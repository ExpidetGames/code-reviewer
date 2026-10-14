// SPDX-License-Identifier: Apache-2.0

// Puts the layers together: built-in values, global defaults, project overrides. Pure.
import type { ReviewCommand } from "../integrations/types.ts";
import {
  REVIEW_SETTING_FIELDS,
  type ProjectDynamicOverrides,
  type ProjectDynamicSettingField,
  type ProjectReviewKind,
  type ReviewSettingField,
  type ReviewSettings,
  type ReviewSettingsOverrides,
} from "./settings.ts";

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

/** Where a project-only value comes from: the shipped default or the project itself. */
export type ProjectDynamicSource = "built_in" | "project";

export type EffectiveProjectDynamic = {
  reviewKind: ProjectReviewKind;
  dynamicModel: string;
  /** The skill text a Dynamic review uses: the project's override, else the shipped default. */
  reviewSkill: string;
  /** Whether `reviewSkill` is the shipped default (the project sets no override). */
  reviewSkillIsDefault: boolean;
  sources: Record<ProjectDynamicSettingField, ProjectDynamicSource>;
};

/**
 * The project-only settings of one project (#194): the kind, the Dynamic model and the skill. There is
 * no global layer here, so a value is either the project's or the shipped default. `builtIn.reviewSkill`
 * is always null; `defaultSkill` is the text of the shipped skill the app and the runner share.
 * Switching kinds changes nothing about the other values: each kind keeps its own model and skill.
 */
export function resolveProjectDynamicSettings(layers: {
  builtIn: {
    reviewKind: ProjectReviewKind;
    dynamicModel: string;
    reviewSkill: string | null;
  };
  project?: ProjectDynamicOverrides;
  defaultSkill: string;
}): EffectiveProjectDynamic {
  const { builtIn, project } = layers;
  const has = <K extends ProjectDynamicSettingField>(field: K): boolean =>
    project !== undefined && project[field] !== undefined;

  const reviewSkillOverride = project?.reviewSkill ?? null;
  const reviewSkillIsDefault = reviewSkillOverride === null;

  const sources = {} as Record<
    ProjectDynamicSettingField,
    ProjectDynamicSource
  >;
  for (const field of ["reviewKind", "dynamicModel"] as const)
    sources[field] = has(field) ? "project" : "built_in";
  // A null (or empty, already normalized to null) override means "no override" and resolves to the
  // shipped default, never to another project's skill.
  sources.reviewSkill = reviewSkillIsDefault ? "built_in" : "project";

  return {
    reviewKind: project?.reviewKind ?? builtIn.reviewKind,
    dynamicModel: project?.dynamicModel ?? builtIn.dynamicModel,
    reviewSkill: reviewSkillOverride ?? layers.defaultSkill,
    reviewSkillIsDefault,
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
