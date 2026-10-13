// SPDX-License-Identifier: Apache-2.0

// How a project form becomes requests (#200). The settings API treats a request as follows (#194):
// any Diff field replaces the whole Diff group, a request with only project-only fields keeps the
// stored Diff group, project-only fields that are left out are kept, an empty request clears the Diff
// group, and `reviewSkill: null` (or `dynamicModel: null`) removes that override. So the form
//
// - sends nothing when nothing changed (an untouched form must never clear the Diff group),
// - sends the Diff group, as a whole, only when it changed,
// - sends a project-only field only when the person changed it,
// - resets the Diff group with an explicit empty request, and, because one request cannot both clear the
//   Diff group and carry project-only fields, sends that reset first and the project-only fields as a
//   second request. A failed second request is a partial save the form reports per card.
import {
  validateProjectSettingsPatch,
  validateReviewSettingsPatch,
  type ReviewSettingIssue,
} from "../validate.ts";
import type {
  ProjectReviewKind,
  ReviewSettingsOverrides,
} from "../settings.ts";
import { initialDynamicValues } from "./dynamic-form-state.ts";
import type { SettingsFormModel } from "./form-model.ts";
import { diffPatch, initialFormState, type FormState } from "./form-state.ts";

/** The two groups a save can change; a failed request is reported against the cards of its group. */
export type SaveCard = "diff" | "kind";

export type SaveStep = {
  cards: readonly SaveCard[];
  body: Record<string, unknown>;
};

export type ProjectSavePlan =
  | {
      ok: true;
      /** The requests, in order; none when nothing changed. */
      steps: SaveStep[];
      /** Set when the review kind changes: the person confirms it first. */
      kindChange: { from: ProjectReviewKind; to: ProjectReviewKind } | null;
    }
  | { ok: false; issues: ReviewSettingIssue[] };

function sameOverrides(
  a: ReviewSettingsOverrides,
  b: ReviewSettingsOverrides,
): boolean {
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  if (keys.length !== other.length) return false;
  return keys.every(
    (key, index) =>
      key === other[index] &&
      JSON.stringify(a[key as keyof ReviewSettingsOverrides]) ===
        JSON.stringify(b[key as keyof ReviewSettingsOverrides]),
  );
}

type ProjectOnly = {
  body: Record<string, unknown>;
  issues: ReviewSettingIssue[];
};

/** The project-only fields the person changed, checked with the server's validator. */
function projectOnlyChanges(
  model: SettingsFormModel,
  state: FormState,
): ProjectOnly {
  const body: Record<string, unknown> = {};
  const issues: ReviewSettingIssue[] = [];
  const view = model.dynamic;
  const values = state.dynamic;
  if (view === undefined || values === undefined) return { body, issues };

  const check = (patch: Record<string, unknown>) => {
    const result = validateProjectSettingsPatch(patch);
    if (!result.ok) issues.push(...result.issues);
    return result.ok;
  };

  if (values.reviewKind !== view.effective.reviewKind)
    body.reviewKind = values.reviewKind;

  // The built-in default typed again (or put back by "Reset to default") clears an override; any
  // other value is the new override.
  const typedModel = values.dynamicModel.trim();
  if (typedModel !== view.effective.dynamicModel) {
    const wanted =
      typedModel === view.defaults.dynamicModel ? null : typedModel;
    if (check({ dynamicModel: wanted })) body.dynamicModel = wanted;
  }

  const shipped = view.defaults.reviewSkill;
  const current = view.reviewSkillIsDefault ? null : view.effective.reviewSkill;
  let wanted: string | null = null;
  if (values.skillMode === "custom") {
    // Empty text is the server's "reset", never what a person who emptied the editor meant.
    if (values.skillText.trim() === "") {
      issues.push({ field: "reviewSkill", code: "EMPTY" });
      wanted = current;
    } else wanted = values.skillText === shipped ? null : values.skillText;
  }
  if (wanted !== current && check({ reviewSkill: wanted }))
    body.reviewSkill = wanted;

  return { body, issues };
}

/** The requests one save makes, or the problems that stop it before anything is sent. */
export function planProjectSave(
  model: SettingsFormModel,
  state: FormState,
): ProjectSavePlan {
  const diff = diffPatch(state);
  const issues = [...diff.issues];
  const projectOnly = projectOnlyChanges(model, state);
  issues.push(...projectOnly.issues);
  if (issues.length > 0) return { ok: false, issues };

  const checked = validateReviewSettingsPatch(diff.raw);
  const diffBody: ReviewSettingsOverrides = checked.ok ? checked.value : {};
  const diffChanged = !sameOverrides(diffBody, model.overrides);
  const projectBody = projectOnly.body;
  const hasProjectBody = Object.keys(projectBody).length > 0;
  const kindChange =
    projectBody.reviewKind === undefined || model.dynamic === undefined
      ? null
      : {
          from: model.dynamic.effective.reviewKind,
          to: projectBody.reviewKind as ProjectReviewKind,
        };

  const steps: SaveStep[] = [];
  if (diffChanged && Object.keys(diff.raw).length > 0) {
    steps.push({
      cards: hasProjectBody ? ["diff", "kind"] : ["diff"],
      body: { ...diff.raw, ...projectBody },
    });
  } else if (diffChanged) {
    steps.push({ cards: ["diff"], body: {} });
    if (hasProjectBody) steps.push({ cards: ["kind"], body: projectBody });
  } else if (hasProjectBody) {
    steps.push({ cards: ["kind"], body: projectBody });
  }
  return { ok: true, steps, kindChange };
}

/**
 * The form state after the cards in `cards` were saved: those cards start again from the saved
 * answer, the others keep what the person typed.
 */
export function adoptCards(
  state: FormState,
  saved: SettingsFormModel,
  cards: readonly SaveCard[],
): FormState {
  const fresh = initialFormState(saved);
  const diff = cards.includes("diff");
  return {
    values: diff ? fresh.values : state.values,
    overridden: diff ? fresh.overridden : state.overridden,
    ...(saved.dynamic === undefined
      ? {}
      : {
          dynamic: cards.includes("kind")
            ? initialDynamicValues(saved.dynamic)
            : (state.dynamic ?? initialDynamicValues(saved.dynamic)),
        }),
  };
}
