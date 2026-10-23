// SPDX-License-Identifier: Apache-2.0

// The logic behind the settings form, without React. The form holds what a person typed as text (a
// number field can hold "abc") plus, per field, whether the person set it for this layer at all: a
// field that is not set is inherited, and a save replaces the whole set of the layer. `buildPatch`
// turns the values into the request body and checks it with the same validator the server uses, so
// the person sees every problem next to its field before anything is sent (the server checks again).
import {
  REVIEW_COMMANDS,
  type ReviewCommand,
} from "../../integrations/types.ts";
import {
  REVIEW_SETTING_FIELDS,
  type ReadableReviewSettings,
  type ReviewSettingField,
  type ReviewSettings,
} from "../settings.ts";
import {
  validateReviewSettingsPatch,
  type ReviewSettingIssue,
} from "../validate.ts";
import {
  initialDynamicValues,
  type DynamicFormValues,
} from "./dynamic-form-state.ts";
import type { SettingsFormModel } from "./form-model.ts";

export type FormValues = {
  /** The provider of `model` (#430, #433); empty for a workspace on the operator's key, which has no field for it. */
  provider: string;
  model: string;
  /** Empty means no fallback model. */
  fallbackModel: string;
  extraInstructions: string;
  maxFindings: string;
  maxTokens: string;
  /** The cost limit in dollars as typed ("1.50"); empty means no limit of this layer (#656). */
  maxCostCents: string;
  largePrChunking: boolean;
  inlineKeyIssues: boolean;
  autoReviewOnOpen: boolean;
  autoReviewOnPush: boolean;
  allowedCommands: ReviewCommand[];
};

export type FormState = {
  values: FormValues;
  /** Fields the person set for this layer; the others are inherited. */
  overridden: Record<ReviewSettingField, boolean>;
  /** The project-only review kind, Dynamic model and skill (#200); absent for the global defaults. */
  dynamic?: DynamicFormValues;
};

/** Whole cents as the dollars a person types ("1.50"); empty for no limit. */
function dollarsOf(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

function valuesOf(settings: ReadableReviewSettings): FormValues {
  return {
    // Absent for a workspace on the operator's key, whose form has no field for them (#283).
    provider: settings.provider ?? "",
    model: settings.model ?? "",
    fallbackModel: settings.fallbackModel ?? "",
    extraInstructions: settings.extraInstructions,
    maxFindings: String(settings.maxFindings),
    maxTokens: String(settings.maxTokens),
    maxCostCents: dollarsOf(settings.maxCostCents ?? null),
    largePrChunking: settings.largePrChunking,
    inlineKeyIssues: settings.inlineKeyIssues,
    autoReviewOnOpen: settings.autoReviewOnOpen,
    autoReviewOnPush: settings.autoReviewOnPush,
    allowedCommands: [...settings.allowedCommands],
  };
}

export function initialFormState(model: SettingsFormModel): FormState {
  const overridden = {} as Record<ReviewSettingField, boolean>;
  for (const field of REVIEW_SETTING_FIELDS)
    overridden[field] = Object.hasOwn(model.overrides, field);
  return {
    values: valuesOf(model.effective),
    overridden,
    ...(model.dynamic === undefined
      ? {}
      : {
          dynamic: initialDynamicValues(
            model.dynamic,
            model.catalog?.selection ?? null,
          ),
        }),
  };
}

export type TextField =
  | "provider"
  | "model"
  | "fallbackModel"
  | "extraInstructions"
  | "maxFindings"
  | "maxTokens"
  | "maxCostCents";
export type BooleanField =
  | "largePrChunking"
  | "inlineKeyIssues"
  | "autoReviewOnOpen"
  | "autoReviewOnPush";

export function setText(
  state: FormState,
  field: TextField,
  value: string,
): FormState {
  return {
    ...state,
    values: { ...state.values, [field]: value },
    // An emptied limit is no limit of this layer: the field follows the layer below again (#656).
    overridden: {
      ...state.overridden,
      [field]: field === "maxCostCents" ? value.trim() !== "" : true,
    },
  };
}

/**
 * Chooses the provider of the Diff models. A model exists only at its provider, so a different provider clears the
 * model and the fallback model typed for the old one: the person names them again (the suggestions switch with the
 * provider). Choosing the provider that is already chosen changes nothing.
 */
export function setProvider(state: FormState, provider: string): FormState {
  if (provider === state.values.provider) return state;
  return {
    ...state,
    values: { ...state.values, provider, model: "", fallbackModel: "" },
    overridden: {
      ...state.overridden,
      provider: true,
      model: true,
      fallbackModel:
        state.overridden.fallbackModel || state.values.fallbackModel !== "",
    },
  };
}

export function setBoolean(
  state: FormState,
  field: BooleanField,
  value: boolean,
): FormState {
  return {
    ...state,
    values: { ...state.values, [field]: value },
    overridden: { ...state.overridden, [field]: true },
  };
}

export function setCommand(
  state: FormState,
  command: ReviewCommand,
  allowed: boolean,
): FormState {
  const chosen = new Set(state.values.allowedCommands);
  if (allowed) chosen.add(command);
  else chosen.delete(command);
  return {
    ...state,
    values: {
      ...state.values,
      // The canonical order, so the same choice always reads the same.
      allowedCommands: REVIEW_COMMANDS.filter((known) => chosen.has(known)),
    },
    overridden: { ...state.overridden, allowedCommands: true },
  };
}

/** Takes a field back to the value it inherits and stops sending it. */
export function resetField(
  state: FormState,
  field: ReviewSettingField,
  model: SettingsFormModel,
): FormState {
  const inherited = valuesOf(model.inherited);
  // The models belong to the provider (see `setProvider`): they go back to the inherited ones together with it.
  const fields: readonly ReviewSettingField[] =
    field === "provider" ? ["provider", "model", "fallbackModel"] : [field];
  const values = { ...state.values };
  const overridden = { ...state.overridden };
  for (const each of fields) {
    Object.assign(values, { [each]: inherited[each] });
    overridden[each] = false;
  }
  return { ...state, values, overridden };
}

/**
 * Puts a model that belongs to the chosen provider back: its own default, set explicitly. The inherited model belongs
 * to the inherited provider, so "Reset to default" must not bring it back next to another provider (#532); and the
 * save then sends the pair, because the layer below holds a model of the other provider.
 */
export function resetModelTo(
  state: FormState,
  defaultModel: string,
): FormState {
  return {
    ...state,
    values: { ...state.values, model: defaultModel },
    overridden: { ...state.overridden, model: true },
  };
}

const WHOLE_NUMBER = /^[+-]?\d+$/;
/** Dollars as typed: "2", "1.50", ".5", each with an optional leading "$". */
const DOLLARS = /^\$?(\d+(\.\d{1,2})?|\.\d{1,2})$/;

/** A typed whole number as a number; text that is no whole number stays text so the validator names it. */
function typedNumber(text: string): number | string {
  const trimmed = text.trim();
  return WHOLE_NUMBER.test(trimmed) ? Number(trimmed) : trimmed;
}

/** Typed dollars as whole cents; text that is no amount stays text so the validator names it. */
function typedCents(text: string): number | string {
  const trimmed = text.trim();
  return DOLLARS.test(trimmed)
    ? Math.round(Number(trimmed.replace("$", "")) * 100)
    : trimmed;
}

function rawValue(values: FormValues, field: ReviewSettingField): unknown {
  switch (field) {
    case "maxCostCents":
      return typedCents(values.maxCostCents);
    case "maxFindings":
    case "maxTokens":
      return typedNumber(values[field]);
    default:
      return values[field];
  }
}

export type PatchResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; issues: ReviewSettingIssue[] };

const NUMBER_FIELDS: readonly ReviewSettingField[] = [
  "maxFindings",
  "maxTokens",
];

/** The fields the person set, as typed values, checked with the same validator the server uses. */
export function diffPatch(state: FormState): {
  raw: Record<string, unknown>;
  issues: ReviewSettingIssue[];
} {
  const raw: Record<string, unknown> = {};
  const issues: ReviewSettingIssue[] = [];
  for (const field of REVIEW_SETTING_FIELDS) {
    if (!state.overridden[field]) continue;
    if (field === "maxCostCents" && state.values.maxCostCents.trim() === "")
      continue;
    // The validator only knows "not a number"; a number field left empty is its own problem.
    if (NUMBER_FIELDS.includes(field) && rawValue(state.values, field) === "") {
      issues.push({ field, code: "EMPTY" });
      continue;
    }
    raw[field] = rawValue(state.values, field);
  }
  const checked = validateReviewSettingsPatch(raw);
  if (!checked.ok) issues.push(...checked.issues);
  return { raw, issues };
}

/** The body of the save request: the fields the person set, checked. The project-only settings are left to the server. */
export function buildPatch(state: FormState): PatchResult {
  const { raw, issues } = diffPatch(state);
  if (issues.length > 0) return { ok: false, issues };
  // The request carries the typed values of the fields that are fine, so what the person sees is
  // what is sent; the server normalizes them (trimmed names, canonical command order) again. The
  // project-only fields are not sent: the server keeps the stored ones a request does not mention,
  // so a stale form cannot overwrite a newer kind, model or skill (#194-T06).
  return { ok: true, patch: raw };
}

/**
 * The settings a review would use with the values as typed, for the live cost estimate; null while
 * a value is wrong (there is nothing sensible to estimate). Project-only fields do not change the
 * Diff estimate (#200), so only the Diff fields are applied.
 */
export function previewSettings(
  model: SettingsFormModel,
  state: FormState,
): ReviewSettings | null {
  // No estimate for a model the workspace does not know (#283).
  if (model.managed) return null;
  const { raw, issues } = diffPatch(state);
  if (issues.length > 0) return null;
  const checked = validateReviewSettingsPatch(raw);
  if (!checked.ok) return null;
  const merged = { ...model.inherited, ...checked.value };
  if (merged.model === undefined || merged.provider === undefined) return null;
  return {
    ...merged,
    provider: merged.provider,
    model: merged.model,
    fallbackModel: merged.fallbackModel ?? null,
  };
}
