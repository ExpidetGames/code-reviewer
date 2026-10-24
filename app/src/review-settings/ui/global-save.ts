// SPDX-License-Identifier: Apache-2.0

// How the form of the workspace defaults becomes a request (#676). A save of the defaults replaces the whole set of the layer
// (a field left out is inherited again), and the set holds the Diff settings next to the review kind, the Dynamic provider and
// model (a catalog entry per kind on the operator's key) and the verdict. So the one request carries every field that differs
// from the shipped value, nothing when nothing changed, and an empty one removes them all. A project differs: its project-only
// fields travel apart from its Diff group (`project-save.ts`).
import {
  CATALOG_FIELD_OF_KIND,
  PROJECT_REVIEW_KINDS,
  type ProjectReviewKind,
} from "../settings.ts";
import { validateWorkspaceSettingsPatch } from "../validate.ts";
import type { SettingsFormModel } from "./form-model.ts";
import { diffPatch, type FormState } from "./form-state.ts";
import type { ProjectSavePlan } from "./project-save.ts";

function sameRecord(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  return (
    keys.length === other.length &&
    keys.every(
      (key, index) =>
        key === other[index] &&
        JSON.stringify(a[key]) === JSON.stringify(b[key]),
    )
  );
}

/** The kind, Dynamic, catalog and verdict fields of the defaults as typed: those that differ from the shipped value. */
function dynamicBody(
  model: SettingsFormModel,
  state: FormState,
): Record<string, unknown> {
  const view = model.dynamic;
  const values = state.dynamic;
  const body: Record<string, unknown> = {};
  if (view === undefined || values === undefined) return body;
  if (values.reviewKind !== view.defaults.reviewKind)
    body.reviewKind = values.reviewKind;
  if (values.reviewVerdict !== view.defaults.reviewVerdict)
    body.reviewVerdict = values.reviewVerdict;
  if (model.managed) {
    for (const kind of PROJECT_REVIEW_KINDS) {
      const entry = values.catalogEntries[kind];
      if (entry !== null) body[CATALOG_FIELD_OF_KIND[kind]] = entry;
    }
    return body;
  }
  if (values.dynamicProvider !== view.defaults.dynamicProvider)
    body.dynamicProvider = values.dynamicProvider;
  const typedModel = values.dynamicModel.trim();
  if (typedModel !== view.defaults.dynamicModel) body.dynamicModel = typedModel;
  return body;
}

/** What the saved defaults hold of those fields, in the shape of `dynamicBody`. */
function storedDynamic(model: SettingsFormModel): Record<string, unknown> {
  const stored: Record<string, unknown> = { ...model.dynamic?.overrides };
  if (model.managed && model.catalog !== null)
    for (const kind of PROJECT_REVIEW_KINDS) {
      const entry = model.catalog.selection[kind];
      if (entry !== null) stored[CATALOG_FIELD_OF_KIND[kind]] = entry;
    }
  return stored;
}

/** The request one save of the workspace defaults makes, or the problems that stop it before anything is sent. */
export function planGlobalSave(
  model: SettingsFormModel,
  state: FormState,
): ProjectSavePlan {
  const diff = diffPatch(state);
  const dynamic = dynamicBody(model, state);
  // Every problem at once, so the form marks all of them.
  const dynamicChecked = validateWorkspaceSettingsPatch(dynamic);
  const issues = [
    ...diff.issues,
    ...(dynamicChecked.ok ? [] : dynamicChecked.issues),
  ];
  if (issues.length > 0) return { ok: false, issues };
  const body = { ...diff.raw, ...dynamic };
  const checked = validateWorkspaceSettingsPatch(body);
  if (!checked.ok) return { ok: false, issues: checked.issues };

  const changed =
    !sameRecord(checked.value.review, model.overrides) ||
    !sameRecord(dynamic, storedDynamic(model));
  const from = model.dynamic?.effective.reviewKind;
  const to: ProjectReviewKind | undefined = state.dynamic?.reviewKind;
  return {
    ok: true,
    steps: changed ? [{ cards: ["diff", "kind"], body }] : [],
    kindChange:
      from === undefined || to === undefined || from === to
        ? null
        : { from, to },
  };
}
