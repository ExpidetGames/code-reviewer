// SPDX-License-Identifier: Apache-2.0

// The project-only part of the settings form (#200): the review kind, the Dynamic model and the review
// skill. Pure functions over the form state, no React. The skill is either the shipped default (shown
// read-only, nothing stored) or a custom text the person edits; resetting it only changes the form until
// the save, and the form keeps the typed values of the kind that is not selected, so toggling the kind
// loses nothing.
import type { CatalogSelection } from "../catalog-selection.ts";
import type { ProjectReviewKind, ReviewVerdictMode } from "../settings.ts";
import type { ProjectDynamicView } from "../service.ts";
import type { FormState } from "./form-state.ts";

export type DynamicFormValues = {
  reviewKind: ProjectReviewKind;
  dynamicModel: string;
  /** The provider of the Dynamic model (#433); empty for a workspace on the operator's key, which has no field for it. */
  dynamicProvider: string;
  /**
   * The catalog entry chosen for each kind (#433), kept side by side so switching the kind loses neither; null: none
   * (the instance default applies). Always null on an own key, where no entry is read or written.
   */
  catalogEntries: CatalogSelection;
  /** `default`: the shipped skill applies and nothing is stored. `custom`: the text below is the override. */
  skillMode: "default" | "custom";
  /** The text of the editor; the shipped text while the default applies. */
  skillText: string;
  /**
   * The text of a custom skill that was staged away with the reset, so "Edit skill" brings it back until
   * the save. Null when there is none.
   */
  draft: string | null;
  /** What a finished review does on its pull request besides the check run (#405). */
  reviewVerdict: ReviewVerdictMode;
};

export function initialDynamicValues(
  view: ProjectDynamicView,
  selection: CatalogSelection | null,
): DynamicFormValues {
  return {
    reviewKind: view.effective.reviewKind,
    // Absent for a workspace on the operator's key (#283); the form has no field for it then.
    dynamicModel: view.effective.dynamicModel ?? "",
    dynamicProvider: view.effective.dynamicProvider ?? "",
    catalogEntries: selection ?? { diff: null, dynamic: null },
    skillMode: view.reviewSkillIsDefault ? "default" : "custom",
    skillText: view.effective.reviewSkill,
    draft: null,
    reviewVerdict: view.effective.reviewVerdict,
  };
}

const UTF8 = new TextEncoder();

/** The size the limit is checked in: UTF-8 bytes, so a multibyte character counts as its bytes. */
export function skillByteLength(text: string): number {
  return UTF8.encode(text).length;
}

function withDynamic(
  state: FormState,
  change: Partial<DynamicFormValues>,
): FormState {
  if (state.dynamic === undefined) return state;
  return { ...state, dynamic: { ...state.dynamic, ...change } };
}

export function setReviewKind(
  state: FormState,
  reviewKind: ProjectReviewKind,
): FormState {
  return withDynamic(state, { reviewKind });
}

export function setReviewVerdict(
  state: FormState,
  reviewVerdict: ReviewVerdictMode,
): FormState {
  return withDynamic(state, { reviewVerdict });
}

export function setDynamicModel(
  state: FormState,
  dynamicModel: string,
): FormState {
  return withDynamic(state, { dynamicModel });
}

/**
 * Chooses the provider of the Dynamic model. A model exists only at its provider, so a different provider clears the
 * model typed for the old one (see `setProvider`).
 */
export function setDynamicProvider(
  state: FormState,
  dynamicProvider: string,
): FormState {
  if (state.dynamic === undefined) return state;
  if (dynamicProvider === state.dynamic.dynamicProvider) return state;
  return withDynamic(state, { dynamicProvider, dynamicModel: "" });
}

/** Chooses the catalog entry of one kind (`null` takes the choice back); the other kind keeps its choice. */
export function setCatalogEntry(
  state: FormState,
  kind: ProjectReviewKind,
  id: string | null,
): FormState {
  if (state.dynamic === undefined) return state;
  return withDynamic(state, {
    catalogEntries: { ...state.dynamic.catalogEntries, [kind]: id },
  });
}

/**
 * Starts a custom skill: from the text that was staged away by a reset when there is one, otherwise from
 * the text in force (the shipped text while the default applies).
 */
export function editSkill(state: FormState, shippedText: string): FormState {
  if (state.dynamic === undefined) return state;
  if (state.dynamic.skillMode === "custom") return state;
  return withDynamic(state, {
    skillMode: "custom",
    skillText: state.dynamic.draft ?? shippedText,
    draft: null,
  });
}

export function setSkillText(state: FormState, skillText: string): FormState {
  return withDynamic(state, { skillMode: "custom", skillText });
}

/**
 * Stages the shipped skill again; stored only by the next save. A custom text the person typed is kept as
 * a draft until then, so an accidental reset loses nothing.
 */
export function resetSkill(state: FormState, shippedText: string): FormState {
  if (state.dynamic === undefined) return state;
  const typed =
    state.dynamic.skillMode === "custom" ? state.dynamic.skillText : null;
  return withDynamic(state, {
    skillMode: "default",
    skillText: shippedText,
    draft:
      typed !== null && typed !== shippedText ? typed : state.dynamic.draft,
  });
}
