// SPDX-License-Identifier: LicenseRef-Proprietary

// What a settings form needs to show, as plain data that survives JSON: the page builds it from the
// service's view on the server, and the browser builds it again from the answer of a save. The same
// form serves the global defaults and one project; the only difference is the layer below the one
// being edited (`inherited`): the built-in values for the global defaults, the global defaults
// (or the built-in values) for a project.
import type {
  GlobalSettingsView,
  ProjectDynamicView,
  ProjectSettingsView,
  ReadableSources,
} from "../service.ts";
import type { ReviewCostGuard } from "../cost.ts";
import type { CatalogChoices, CatalogSelection } from "../catalog-selection.ts";
import {
  type ReadableReviewSettings,
  type ReviewSettingsOverrides,
} from "../settings.ts";

/**
 * What a project form of a workspace on the operator's key chooses from (#433): per kind the entries it may pick, and
 * the entry the project has now. Only names, descriptions and ids: the view holds neither a provider nor a model.
 */
export type CatalogFormModel = {
  choices: CatalogChoices;
  selection: CatalogSelection;
};

export type SettingsFormModel = {
  mode: "global" | "project";
  /** What each field is while this layer does not set it. */
  inherited: ReadableReviewSettings;
  /** The fields this layer sets. */
  overrides: ReviewSettingsOverrides;
  /** What a review uses with the saved overrides. */
  effective: ReadableReviewSettings;
  /** Where each field of `effective` comes from. */
  sources: ReadableSources;
  /** The estimate of a review; null for a workspace on the operator's key, which has no model of its own (#283). */
  cost: ReviewCostGuard | null;
  /**
   * The workspace reviews on the operator's key (#283): the form offers a choice of the catalog instead of the
   * provider, the model, the fallback model and the Dynamic model, and shows no cost estimate. The settings it was
   * built from hold no model.
   */
  managed: boolean;
  /**
   * The entries of the catalog a project of such a workspace chooses from (#433); null for a workspace on its own
   * key, for the workspace defaults (no workspace-level default entry, decision C3) and for an answer of a server
   * that does not know the catalog.
   */
  catalog: CatalogFormModel | null;
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
    managed: view.modelManagedByInstance,
    catalog: null,
    lastSaved:
      view.updatedAt === null
        ? null
        : { at: view.updatedAt, by: view.updatedBy },
  };
}

/** The catalog view of a project; an answer of a server from before #430 carries neither part. */
function catalogOf(view: ProjectSettingsView): CatalogFormModel | null {
  const { catalogChoices, catalogSelection } = view;
  if (!catalogChoices || !catalogSelection) return null;
  return { choices: catalogChoices, selection: catalogSelection };
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
    managed: view.modelManagedByInstance,
    catalog: catalogOf(view),
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
  // `cost` is null for a workspace on the operator's key.
  if (
    !has("effective") ||
    !has("overrides") ||
    !has("sources") ||
    !Object.hasOwn(view, "cost")
  )
    return null;
  if (mode === "global") {
    if (!has("builtIn")) return null;
    return modelFromGlobalView(withManagedFlag(answer as GlobalSettingsView));
  }
  if (!has("inherited")) return null;
  return modelFromProjectView(withManagedFlag(answer as ProjectSettingsView));
}

/** An answer of a server that does not know the flag (the release before #283) is not managed. */
function withManagedFlag<T extends GlobalSettingsView | ProjectSettingsView>(
  view: T,
): T {
  return {
    ...view,
    modelManagedByInstance: view.modelManagedByInstance === true,
  };
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
