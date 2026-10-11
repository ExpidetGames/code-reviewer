// SPDX-License-Identifier: Apache-2.0

// Puts the layers together: built-in values, global defaults, project overrides. Pure.
import type { ReviewCommand } from "../integrations/types.ts";
import {
  REVIEW_SETTING_FIELDS,
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
