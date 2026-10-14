// SPDX-License-Identifier: Apache-2.0

// What a settings form needs to show, as plain data that survives JSON: the page builds it from the
// service's view on the server, and the browser builds it again from the answer of a save. The same
// form serves the global defaults and one project; the only difference is the layer below the one
// being edited (`inherited`): the built-in values for the global defaults, the global defaults
// (or the built-in values) for a project.
import type {
  GlobalSettingsView,
  ProjectDynamicView,
  ProjectSettingsView,
} from "../service.ts";
import type { ReviewCostGuard } from "../cost.ts";
import type { SettingSource } from "../effective.ts";
import {
  type ReviewSettingField,
  type ReviewSettings,
  type ReviewSettingsOverrides,
} from "../settings.ts";

export type SettingsFormModel = {
  mode: "global" | "project";
  /** What each field is while this layer does not set it. */
  inherited: ReviewSettings;
  /** The fields this layer sets. */
  overrides: ReviewSettingsOverrides;
  /** What a review uses with the saved overrides. */
  effective: ReviewSettings;
  /** Where each field of `effective` comes from. */
  sources: Record<ReviewSettingField, SettingSource>;
  cost: ReviewCostGuard;
  /** Who saved the global defaults last and when; null for a project or before the first save. */
  lastSaved: { at: string; by: string | null } | null;
  /**
   * The project-only review kind, Dynamic model and skill (#194); absent for the global defaults,
   * which cannot hold them. Since #200 the project form edits them: it sends a project-only field
   * only when the person changed it, so a stale form cannot overwrite a newer value, and a
   * `reviewSkill` of `null` (or `""`) clears the skill override.
   */
  dynamic?: ProjectDynamicView;
};

export function modelFromGlobalView(
  view: GlobalSettingsView,
): SettingsFormModel {
  return {
    mode: "global",
    inherited: view.builtIn,
    overrides: view.overrides,
    effective: view.effective,
    sources: view.sources,
    cost: view.cost,
    lastSaved:
      view.updatedAt === null
        ? null
        : { at: view.updatedAt, by: view.updatedBy },
  };
}

export function modelFromProjectView(
  view: ProjectSettingsView,
): SettingsFormModel {
  return {
    mode: "project",
    inherited: view.inherited,
    overrides: view.overrides,
    effective: view.effective,
    sources: view.sources,
    cost: view.cost,
    lastSaved: null,
    dynamic: view.dynamic,
  };
}

/**
 * Reads the JSON answer of a settings route (the view plus the limits) as a form model, or null when
 * the answer is not shaped like one. Our own server wrote it, so this is a guard against a wrong
 * route or a proxy page, not against an attacker.
 */
export function modelFromAnswer(
  mode: SettingsFormModel["mode"],
  answer: unknown,
): SettingsFormModel | null {
  if (typeof answer !== "object" || answer === null) return null;
  const view = answer as Record<string, unknown>;
  const has = (key: string) =>
    typeof view[key] === "object" && view[key] !== null;
  if (!has("effective") || !has("overrides") || !has("sources") || !has("cost"))
    return null;
  if (mode === "global") {
    if (!has("builtIn")) return null;
    return modelFromGlobalView(answer as GlobalSettingsView);
  }
  if (!has("inherited")) return null;
  return modelFromProjectView(answer as ProjectSettingsView);
}

/**
 * The notes of a save that went through (a Dynamic model that could not be checked, #269), as the
 * `{ field, code }` pairs of the answer. Anything that is not shaped like one is dropped.
 */
export function warningsFromAnswer(
  answer: unknown,
): Array<{ field: string; code: string }> {
  if (typeof answer !== "object" || answer === null) return [];
  const list = (answer as { warnings?: unknown }).warnings;
  if (!Array.isArray(list)) return [];
  const warnings: Array<{ field: string; code: string }> = [];
  for (const entry of list as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { field, code } = entry as { field?: unknown; code?: unknown };
    if (typeof field === "string" && typeof code === "string")
      warnings.push({ field, code });
  }
  return warnings;
}
