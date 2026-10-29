// SPDX-License-Identifier: LicenseRef-Proprietary

// How the form of the workspace defaults becomes a request (#676). A save of the defaults replaces the whole set of the layer
// (a field left out is inherited again), and the set holds the Diff settings next to the review kind, the Dynamic provider and
// model (a catalog entry per kind on the operator's key) and the verdict. So the one request carries every field that differs
// from the shipped value, nothing when nothing changed, and an empty one removes them all. A project differs: its project-only
// fields travel apart from its Diff group (`project-save.ts`).
import { CATALOG_FIELD_OF_KIND } from "../settings.ts";
import {
  PROJECT_REVIEW_KINDS,
  type ProjectReviewKind,
} from "../../job-kind/job-kind.ts";
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

/**
 * The Dynamic, catalog and verdict fields of the defaults as typed: those that differ from the shipped value. The kind is not
 * among them: it always travels (see `planGlobalSave`).
 */
function dynamicBody(
  model: SettingsFormModel,
  state: FormState,
): Record<string, unknown> {
  const view = model.dynamic;
  const values = state.dynamic;
  const body: Record<string, unknown> = {};
  if (view === undefined || values === undefined) return body;
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
  delete stored.reviewKind;
  if (model.managed && model.catalog !== null)
    for (const kind of PROJECT_REVIEW_KINDS) {
      const entry = model.catalog.selection[kind];
      if (entry !== null) stored[CATALOG_FIELD_OF_KIND[kind]] = entry;
    }
  return stored;
}

/**
 * The request one save of the workspace defaults makes, or the problems that stop it before anything is sent. The chosen review
 * kind is always in it, Diff Review too: a save replaces the whole set, and a kind left out would be taken back, so projects
 * and new projects would follow the shipped kind (Dynamic Review where it can run) while the page shows Diff Review.
 */
export function planGlobalSave(
  model: SettingsFormModel,
  state: FormState,
): ProjectSavePlan {
  const diff = diffPatch(state);
  const dynamic = dynamicBody(model, state);
  const kind: ProjectReviewKind | undefined = state.dynamic?.reviewKind;
  // Every problem at once, so the form marks all of them.
  const dynamicChecked = validateWorkspaceSettingsPatch(dynamic);
  const issues = [
    ...diff.issues,
    ...(dynamicChecked.ok ? [] : dynamicChecked.issues),
  ];
  if (issues.length > 0) return { ok: false, issues };
  const body = {
    ...diff.raw,
    ...dynamic,
    ...(kind === undefined ? {} : { reviewKind: kind }),
  };
  const checked = validateWorkspaceSettingsPatch(body);
  if (!checked.ok) return { ok: false, issues: checked.issues };

  const from = model.dynamic?.effective.reviewKind;
  // The kind counts as changed when it differs from the one in force, or when the person chose one and none is stored yet.
  const kindChanged =
    kind !== undefined &&
    (kind !== from ||
      (state.dynamic?.kindChosen === true &&
        model.dynamic?.overrides.reviewKind === undefined));
  const changed =
    kindChanged ||
    !sameRecord(checked.value.review, model.overrides) ||
    !sameRecord(dynamic, storedDynamic(model));
  return {
    ok: true,
    steps: changed ? [{ cards: ["diff", "kind"], body }] : [],
    kindChange:
      from === undefined || kind === undefined || from === kind
        ? null
        : { from, to: kind },
  };
}
