// SPDX-License-Identifier: Apache-2.0

// The copy for review settings: what a problem with one field means and what to do about it, and what
// a save that failed as a whole means. The service answers with stable codes (a field and a code per
// problem); this is where a code becomes a sentence next to its field. A code is never shown.
import { REVIEW_SETTING_LIMITS, type ReviewSettingField } from "../settings.ts";
import {
  CROSS_SITE_REQUEST_RELOAD_PAGE,
  REQUEST_NOT_UNDERSTOOD,
} from "../../copy/messages.ts";
import type { ReviewSettingIssueCode } from "../validate.ts";
import type { ReviewSettingsErrorCode } from "../errors.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const GENERIC_ISSUE = "This value is not valid.";
const MODEL_FIELDS: readonly string[] = ["model", "fallbackModel"];

function numberWithCommas(value: number): string {
  return value.toLocaleString("en-US");
}

const ISSUE_COPY: Record<ReviewSettingIssueCode, (field: string) => string> = {
  UNKNOWN_FIELD: () => "This setting does not exist.",
  INVALID_TYPE: (field) => {
    switch (field) {
      case "maxFindings":
      case "maxTokens":
        return "Enter a whole number.";
      case "allowedCommands":
        return "Choose from the listed commands.";
      case "extraInstructions":
        return "Enter text.";
      default:
        return MODEL_FIELDS.includes(field)
          ? "Enter a model name."
          : GENERIC_ISSUE;
    }
  },
  EMPTY: (field) =>
    field === "model" ? "Enter a model name." : "Enter a value.",
  TOO_SMALL: (field) => {
    if (field === "maxFindings")
      return `Enter ${String(REVIEW_SETTING_LIMITS.maxFindings.min)} or more.`;
    if (field === "maxTokens")
      return `Enter ${numberWithCommas(REVIEW_SETTING_LIMITS.maxTokens.min)} or more.`;
    return "This value is too small.";
  },
  TOO_LARGE: (field) => {
    if (field === "maxFindings")
      return `Enter ${String(REVIEW_SETTING_LIMITS.maxFindings.max)} or less.`;
    if (field === "maxTokens")
      return `Enter ${numberWithCommas(REVIEW_SETTING_LIMITS.maxTokens.max)} or less.`;
    return "This value is too large.";
  },
  TOO_LONG: (field) =>
    field === "extraInstructions"
      ? `Use at most ${numberWithCommas(REVIEW_SETTING_LIMITS.extraInstructionsMaxChars)} characters.`
      : "This text is too long.",
  INVALID_FORMAT: (field) => {
    if (field === "allowedCommands")
      return "Only the commands review, improve, describe and ask exist.";
    if (MODEL_FIELDS.includes(field))
      return "Use a model name as OpenRouter spells it, for example anthropic/claude-haiku-5.5 (letters, digits and . _ : / + -, no spaces).";
    return GENERIC_ISSUE;
  },
  DUPLICATE_ENTRY: () => "Each command can be chosen only once.",
  FORBIDDEN_CHARACTERS: () =>
    "Remove the control characters. Tabs and line breaks are fine.",
  EXCEEDS_MODEL_CONTEXT: (field) =>
    field === "maxTokens"
      ? "The token budget is larger than the context window of the chosen model. Lower it or choose a model with a larger context window."
      : "The context window of this model is smaller than the token budget. Choose another model or lower the token budget.",
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

const SAVE_FAILURE_COPY: Record<ReviewSettingsErrorCode, string> = {
  REVIEW_SETTINGS_INVALID:
    "Some settings are not valid. Fix the marked fields and save again.",
  REVIEW_SETTINGS_REQUEST_INVALID: REQUEST_NOT_UNDERSTOOD,
  REVIEW_SETTINGS_CROSS_SITE_REQUEST: CROSS_SITE_REQUEST_RELOAD_PAGE,
  REVIEW_SETTINGS_BODY_TOO_LARGE: "The settings are too large to save.",
  REVIEW_SETTINGS_CONTENT_TYPE_UNSUPPORTED: REQUEST_NOT_UNDERSTOOD,
  REVIEW_SETTINGS_PROJECT_NOT_FOUND:
    "This repository was not found. Reload the Projects page and try again.",
};

/** The sentence for a save (or reset) that failed as a whole. */
export function describeSaveFailure(code: string): string {
  if (Object.hasOwn(SAVE_FAILURE_COPY, code))
    return SAVE_FAILURE_COPY[code as ReviewSettingsErrorCode];
  return describeTransportFailure(code) ?? GENERIC_FAILURE;
}
