// SPDX-License-Identifier: Apache-2.0

// The copy for review settings: what a problem with one field means and what to do about it, and what
// a save that failed as a whole means. The service answers with stable codes (a field and a code per
// problem); this is where a code becomes a sentence next to its field. A code is never shown.
import { DEFAULT_LLM_MODEL } from "../../llm/config.ts";
import { DEFAULT_LLM_PROVIDER_LABEL } from "../../llm/providers/index.ts";
import {
  DEFAULT_DYNAMIC_MODEL,
  PROJECT_DYNAMIC_LIMITS,
  REVIEW_SETTING_LIMITS,
  type ReviewSettingField,
} from "../settings.ts";
import {
  CROSS_SITE_REQUEST_RELOAD_PAGE,
  REQUEST_NOT_UNDERSTOOD,
} from "../../copy/messages.ts";
import type {
  ReviewSettingIssueCode,
  ReviewSettingWarningCode,
} from "../validate.ts";
import type { ReviewSettingsErrorCode } from "../errors.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const GENERIC_ISSUE = "This value is not valid.";
const MODEL_FIELDS: readonly string[] = [
  "model",
  "fallbackModel",
  "dynamicModel",
];

const PROVIDER_FIELDS: readonly string[] = ["provider", "dynamicProvider"];
const ENTRY_FIELDS: readonly string[] = [
  "catalogEntryDiff",
  "catalogEntryDynamic",
];
/** After the Diff provider changed while a fallback model was stored: a fallback of another provider is invalid, so it went. */
export const FALLBACK_REMOVED_NOTICE =
  "The fallback model of the previous provider was removed.";
/** Read after the name of a tab whose section holds a field with a problem ("LLM (has a problem)"). */
export const TAB_PROBLEM_NOTE = "(has a problem)";
const CHOOSE_PROVIDER = "Choose one of the listed providers.";
const CHOOSE_OPTION = "Choose one of the listed options.";

/** What to say when a provider or an entry is not a well-formed choice at all (a form can only send a listed one). */
function malformedChoice(field: string): string | null {
  if (PROVIDER_FIELDS.includes(field)) return CHOOSE_PROVIDER;
  return ENTRY_FIELDS.includes(field) ? CHOOSE_OPTION : null;
}

function numberWithCommas(value: number): string {
  return value.toLocaleString("en-US");
}

const COST_RANGE = `Enter an amount from $${(REVIEW_SETTING_LIMITS.maxCostCents.min / 100).toFixed(2)} to $${String(REVIEW_SETTING_LIMITS.maxCostCents.max / 100)}.`;

const ISSUE_COPY: Record<ReviewSettingIssueCode, (field: string) => string> = {
  UNKNOWN_FIELD: () => "This setting does not exist.",
  INVALID_TYPE: (field) => {
    const choice = malformedChoice(field);
    if (choice !== null) return choice;
    switch (field) {
      case "maxFindings":
      case "maxTokens":
        return "Enter a whole number.";
      case "maxCostCents":
        return "Enter an amount in dollars with up to two decimals, like 0.50 or 2.";
      case "allowedCommands":
        return "Choose from the listed commands.";
      case "extraInstructions":
      case "reviewSkill":
        return "Enter text.";
      default:
        return MODEL_FIELDS.includes(field)
          ? "Enter a model name."
          : GENERIC_ISSUE;
    }
  },
  EMPTY: (field) => {
    const choice = malformedChoice(field);
    if (choice !== null) return choice;
    if (field === "model" || field === "dynamicModel")
      return "Enter a model name.";
    if (field === "reviewSkill")
      return "Enter the skill text, or reset the skill to the default.";
    return "Enter a value.";
  },
  TOO_SMALL: (field) => {
    if (field === "maxCostCents") return COST_RANGE;
    if (field === "maxFindings")
      return `Enter ${String(REVIEW_SETTING_LIMITS.maxFindings.min)} or more.`;
    if (field === "maxTokens")
      return `Enter ${numberWithCommas(REVIEW_SETTING_LIMITS.maxTokens.min)} or more.`;
    return "This value is too small.";
  },
  TOO_LARGE: (field) => {
    if (field === "maxCostCents") return COST_RANGE;
    if (field === "maxFindings")
      return `Enter ${String(REVIEW_SETTING_LIMITS.maxFindings.max)} or less.`;
    if (field === "maxTokens")
      return `Enter ${numberWithCommas(REVIEW_SETTING_LIMITS.maxTokens.max)} or less.`;
    return "This value is too large.";
  },
  TOO_LONG: (field) => {
    const choice = malformedChoice(field);
    if (choice !== null) return choice;
    if (field === "extraInstructions")
      return `Use at most ${numberWithCommas(REVIEW_SETTING_LIMITS.extraInstructionsMaxChars)} characters.`;
    if (field === "reviewSkill")
      return `Use at most ${numberWithCommas(PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes)} bytes. Characters outside plain English letters count as several bytes.`;
    return "This text is too long.";
  },
  INVALID_FORMAT: (field) => {
    const choice = malformedChoice(field);
    if (choice !== null) return choice;
    if (field === "allowedCommands") return "Only the command review exists.";
    if (field === "reviewKind") return "Choose Diff Review or Dynamic Review.";
    if (field === "reviewVerdict")
      return "Choose Off, Blocking findings or Any finding.";
    if (field === "dynamicModel")
      return `Use a model name as your provider spells it, for example ${DEFAULT_DYNAMIC_MODEL} (letters, digits and . _ : / + -, no spaces).`;
    if (MODEL_FIELDS.includes(field))
      return `Use a model name as ${DEFAULT_LLM_PROVIDER_LABEL} spells it, for example ${DEFAULT_LLM_MODEL} (letters, digits and . _ : / + -, no spaces).`;
    return GENERIC_ISSUE;
  },
  DUPLICATE_ENTRY: () => "Each command can be chosen only once.",
  FORBIDDEN_CHARACTERS: () =>
    "Remove the control characters. Tabs and line breaks are fine.",
  EXCEEDS_MODEL_CONTEXT: (field) =>
    field === "maxTokens"
      ? "The token budget is larger than the context window of the chosen model. Lower it or choose a model with a larger context window."
      : "The context window of this model is smaller than the token budget. Choose another model or lower the token budget.",
  DYNAMIC_MODEL_TOOLS_UNSUPPORTED: () =>
    "This model does not support tool calling, which Dynamic Review needs. Choose another model.",
  DYNAMIC_MODEL_UNKNOWN: () =>
    `The provider lists no model with this name. Check the spelling, for example ${DEFAULT_DYNAMIC_MODEL}.`,
  MODEL_MANAGED_BY_INSTANCE: () =>
    "code-review.com provides the AI models for this workspace. Choose from the listed options instead.",
  PROVIDER_UNKNOWN: () => CHOOSE_PROVIDER,
  CATALOG_ENTRY_UNKNOWN: () => "This choice does not exist. Choose another.",
  CATALOG_ENTRY_NOT_RELEASED: () =>
    "This choice is not available any more. Choose another.",
  CATALOG_ENTRY_KIND_MISMATCH: (field) =>
    field === "catalogEntryDynamic"
      ? "This choice is not made for Dynamic Review. Choose another."
      : "This choice is not made for Diff Review. Choose another.",
  CATALOG_ENTRY_NOT_ALLOWED: () =>
    "Your plan does not include this choice. Choose another or change your plan.",
  MODEL_PROVIDER_MISMATCH: () =>
    "The model that applies was chosen for another provider. Set a model for this provider too, or use the provider the model was chosen for.",
  // #555: the catalog is the list of a catalog provider; a model new at the provider is missing for up to a day.
  MODEL_NOT_IN_CATALOG: () =>
    "This model is not in the catalog. Pick one from the list. A model that was released only recently can take up to a day to appear.",
  // #588: the address of a catalog provider cannot be confirmed when there is none.
  PROVIDER_ADDRESS_NOT_PINNABLE: () =>
    "There is no provider address to confirm right now. Choose the provider and a model from the catalog first.",
  // The user has to be on the operator's key before an entry can be chosen (#430): say so, and nothing about a model.
  CATALOG_ENTRY_OWN_KEY_MODE: () =>
    "This workspace reviews with its own AI key, so the code-review.com choices cannot be used. They can be chosen once the workspace is billed via code-review.com.",
};

function hasIssueCopy(code: string): code is ReviewSettingIssueCode {
  return Object.hasOwn(ISSUE_COPY, code);
}

/** The sentence shown next to a field for the code the validation reported. */
export function describeIssue(
  field: ReviewSettingField | string,
  code: string,
): string {
  return hasIssueCopy(code) ? ISSUE_COPY[code](field) : GENERIC_ISSUE;
}

const WARNING_COPY: Record<ReviewSettingWarningCode, string> = {
  DYNAMIC_MODEL_UNVERIFIED:
    "The model could not be checked for tool support right now, so it was saved unchecked. A Dynamic review fails if the model does not support tool calling.",
};

/** The sentence for a note on a save that went through, or null for a note this version does not know. */
export function describeWarning(
  _field: ReviewSettingField | string,
  code: string,
): string | null {
  return Object.hasOwn(WARNING_COPY, code)
    ? WARNING_COPY[code as ReviewSettingWarningCode]
    : null;
}

const SAVE_FAILURE_COPY: Record<ReviewSettingsErrorCode, string> = {
  REVIEW_SETTINGS_INVALID:
    "Some settings are not valid. Fix the marked fields and save again.",
  REVIEW_SETTINGS_REQUEST_INVALID: REQUEST_NOT_UNDERSTOOD,
  REVIEW_SETTINGS_CROSS_SITE_REQUEST: CROSS_SITE_REQUEST_RELOAD_PAGE,
  REVIEW_SETTINGS_BODY_TOO_LARGE: "The settings are too large to save.",
  REVIEW_SETTINGS_CONTENT_TYPE_UNSUPPORTED: REQUEST_NOT_UNDERSTOOD,
  REVIEW_SETTINGS_PROJECT_NOT_FOUND:
    "This repository was not found. Reload the Projects page and try again.",
  // #588: the address of a catalog provider is confirmed, moved or dropped by an Owner or Admin only.
  PROVIDER_ADDRESS_CONFIRM_FORBIDDEN:
    "The address of this provider changed. Only an Owner or Admin of the workspace can confirm it or change the provider of this project.",
  // #614: a save that would pin an address another project of the workspace holds differently (also a model-only save of an older selection).
  PROVIDER_ADDRESS_OTHER_PROJECT_PIN:
    "Another project of this workspace uses this provider at a different address, so this project cannot take the current one. Ask an Owner or Admin of the workspace to save it.",
};

/** The sentence for a save (or reset) that failed as a whole. */
export function describeSaveFailure(code: string): string {
  if (Object.hasOwn(SAVE_FAILURE_COPY, code))
    return SAVE_FAILURE_COPY[code as ReviewSettingsErrorCode];
  return describeTransportFailure(code) ?? GENERIC_FAILURE;
}
