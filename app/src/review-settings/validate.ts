// SPDX-License-Identifier: Apache-2.0

// Checks review settings that come from outside (a request body) or from storage. Pure: no database,
// no environment. Every problem is reported as `{ field, code }` with a stable code; the message a
// person reads is the UI's business, and a value is never echoed back.
import { REVIEW_COMMANDS, type ReviewCommand } from "../integrations/types.ts";
import { MODEL_NAME_PATTERN } from "../llm/config.ts";
import {
  PROJECT_DYNAMIC_LIMITS,
  PROJECT_DYNAMIC_SETTING_FIELDS,
  PROJECT_REVIEW_KINDS,
  REVIEW_SETTING_FIELDS,
  REVIEW_SETTING_LIMITS,
  type ProjectDynamicOverrides,
  type ProjectDynamicPatch,
  type ProjectDynamicSettingField,
  type ProjectReviewKind,
  type ReviewSettingField,
  type ReviewSettings,
  type ReviewSettingsOverrides,
} from "./settings.ts";

export const REVIEW_SETTING_ISSUE_CODES = [
  /** A field this version does not know. */
  "UNKNOWN_FIELD",
  /** Not the kind of value the field holds (a string for a number, a fraction for a count, ...). */
  "INVALID_TYPE",
  /** Empty (or only spaces) where a value is required. */
  "EMPTY",
  "TOO_SMALL",
  "TOO_LARGE",
  "TOO_LONG",
  /** A value that is not allowed: a model name with a space, an unknown command. */
  "INVALID_FORMAT",
  "DUPLICATE_ENTRY",
  /** Control characters (other than tab and line breaks) or an unpaired surrogate. */
  "FORBIDDEN_CHARACTERS",
  /**
   * The token budget is larger than the context window of the model (a model the price table knows).
   * Reported on `maxTokens` when the request sets it, otherwise on the model that became too small.
   */
  "EXCEEDS_MODEL_CONTEXT",
] as const;
export type ReviewSettingIssueCode =
  (typeof REVIEW_SETTING_ISSUE_CODES)[number];

export type ReviewSettingIssue = {
  /** The field the problem is about; `settings` when it is about the whole object. */
  field:
    | ReviewSettingField
    | ProjectDynamicSettingField
    | "settings"
    | (string & {});
  code: ReviewSettingIssueCode;
};

type FieldResult<T> =
  { ok: true; value: T } | { ok: false; code: ReviewSettingIssueCode };

const ok = <T>(value: T): FieldResult<T> => ({ ok: true, value });
const fail = (code: ReviewSettingIssueCode): FieldResult<never> => ({
  ok: false,
  code,
});

function modelName(value: unknown): FieldResult<string> {
  if (typeof value !== "string") return fail("INVALID_TYPE");
  const name = value.trim();
  if (name === "") return fail("EMPTY");
  if (!MODEL_NAME_PATTERN.test(name)) return fail("INVALID_FORMAT");
  return ok(name);
}

function fallbackModel(value: unknown): FieldResult<string | null> {
  if (value === null) return ok(null);
  if (typeof value === "string" && value.trim() === "") return ok(null);
  return modelName(value);
}

// Tab and line breaks are fine in free text; every other control character (a NUL cannot even be
// put into an environment variable) and an unpaired surrogate (no valid UTF-8) is not.
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

function hasLoneSurrogate(text: string): boolean {
  return !text.isWellFormed();
}

function instructions(value: unknown): FieldResult<string> {
  if (typeof value !== "string") return fail("INVALID_TYPE");
  if (FORBIDDEN_TEXT.test(value) || hasLoneSurrogate(value))
    return fail("FORBIDDEN_CHARACTERS");
  if (value.length > REVIEW_SETTING_LIMITS.extraInstructionsMaxChars)
    return fail("TOO_LONG");
  // Only spaces and line breaks are no rules at all.
  return ok(value.trim() === "" ? "" : value);
}

function integerBetween(min: number, max: number) {
  return (value: unknown): FieldResult<number> => {
    if (typeof value !== "number" || !Number.isInteger(value))
      return fail("INVALID_TYPE");
    if (value < min) return fail("TOO_SMALL");
    if (value > max) return fail("TOO_LARGE");
    return ok(value);
  };
}

function bool(value: unknown): FieldResult<boolean> {
  return typeof value === "boolean" ? ok(value) : fail("INVALID_TYPE");
}

function commands(value: unknown): FieldResult<ReviewCommand[]> {
  if (!Array.isArray(value)) return fail("INVALID_TYPE");
  const seen = new Set<ReviewCommand>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string") return fail("INVALID_TYPE");
    const command = REVIEW_COMMANDS.find((known) => known === entry);
    if (command === undefined) return fail("INVALID_FORMAT");
    if (seen.has(command)) return fail("DUPLICATE_ENTRY");
    seen.add(command);
  }
  // The canonical order, so the same set is always stored and shown the same way.
  return ok(REVIEW_COMMANDS.filter((command) => seen.has(command)));
}

const FIELD_CHECKS: {
  [K in ReviewSettingField]: (value: unknown) => FieldResult<ReviewSettings[K]>;
} = {
  model: modelName,
  fallbackModel,
  extraInstructions: instructions,
  maxFindings: integerBetween(
    REVIEW_SETTING_LIMITS.maxFindings.min,
    REVIEW_SETTING_LIMITS.maxFindings.max,
  ),
  maxTokens: integerBetween(
    REVIEW_SETTING_LIMITS.maxTokens.min,
    REVIEW_SETTING_LIMITS.maxTokens.max,
  ),
  largePrChunking: bool,
  inlineKeyIssues: bool,
  autoReviewOnOpen: bool,
  autoReviewOnPush: bool,
  allowedCommands: commands,
};

export type ValidationResult =
  | { ok: true; value: ReviewSettingsOverrides }
  | { ok: false; issues: ReviewSettingIssue[] };

// --- The project-only settings (#194). They never appear in the global validation below. ---

function reviewKind(value: unknown): FieldResult<ProjectReviewKind> {
  if (typeof value !== "string") return fail("INVALID_TYPE");
  const known = PROJECT_REVIEW_KINDS.find((kind) => kind === value);
  return known === undefined ? fail("INVALID_FORMAT") : ok(known);
}

// The skill is untrusted text: a size bound in UTF-8 bytes (multibyte characters count as their
// bytes), no forbidden control characters, no unpaired surrogate. Those are checked on the raw text
// before an empty (or blank) value is read as an explicit reset to the shipped default, so forbidden
// or oversized text is refused rather than silently normalized away.
const UTF8 = new TextEncoder();

function reviewSkill(value: unknown): FieldResult<string | null> {
  if (value === null) return ok(null);
  if (typeof value !== "string") return fail("INVALID_TYPE");
  if (FORBIDDEN_TEXT.test(value) || hasLoneSurrogate(value))
    return fail("FORBIDDEN_CHARACTERS");
  if (UTF8.encode(value).length > PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes)
    return fail("TOO_LONG");
  if (value.trim() === "") return ok(null);
  return ok(value);
}

/** The Dynamic model of a project save: like the Diff model, or `null` to clear the override (#200). */
function dynamicModelValue(value: unknown): FieldResult<string | null> {
  if (value === null) return ok(null);
  return modelName(value);
}

const DYNAMIC_FIELD_CHECKS: {
  [K in ProjectDynamicSettingField]: (
    value: unknown,
  ) => FieldResult<ProjectDynamicPatch[K]>;
} = {
  reviewKind,
  // The same rule as the Diff model: the identifier is kept literally, no provider rewrite (#194-T08).
  dynamicModel: dynamicModelValue,
  reviewSkill,
};

export type ProjectSettingsPatch = {
  review: ReviewSettingsOverrides;
  dynamic: ProjectDynamicPatch;
};

export type ProjectValidationResult =
  | { ok: true; value: ProjectSettingsPatch }
  | { ok: false; issues: ReviewSettingIssue[] };

function isProjectDynamicField(
  name: string,
): name is ProjectDynamicSettingField {
  return (PROJECT_DYNAMIC_SETTING_FIELDS as readonly string[]).includes(name);
}

function checkDynamicField<K extends ProjectDynamicSettingField>(
  target: ProjectDynamicPatch,
  field: K,
  raw: unknown,
): ReviewSettingIssue | undefined {
  const result = DYNAMIC_FIELD_CHECKS[field](raw);
  if (!result.ok) return { field, code: result.code };
  target[field] = result.value as ProjectDynamicPatch[K];
  return undefined;
}

/**
 * Validates the settings of one project: the Diff overrides **and** the project-only fields (kind,
 * Dynamic model, skill). The global defaults use `validateReviewSettingsPatch`, which does not know
 * the project-only fields, so they cannot become workspace-wide values.
 */
export function validateProjectSettingsPatch(
  input: unknown,
): ProjectValidationResult {
  if (!isPlainObject(input))
    return { ok: false, issues: [{ field: "settings", code: "INVALID_TYPE" }] };
  const review: ReviewSettingsOverrides = {};
  const dynamic: ProjectDynamicPatch = {};
  const issues: ReviewSettingIssue[] = [];
  for (const [name, raw] of Object.entries(input)) {
    if (isProjectDynamicField(name)) {
      const issue = checkDynamicField(dynamic, name, raw);
      if (issue !== undefined) issues.push(issue);
      continue;
    }
    if (!isField(name)) {
      issues.push({
        field: /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "settings",
        code: "UNKNOWN_FIELD",
      });
      continue;
    }
    const issue = checkField(review, name, raw);
    if (issue !== undefined) issues.push(issue);
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: { review, dynamic } };
}

/**
 * Reads the project-only fields of a stored layer. Like `parseStoredOverrides`, a field this version
 * would not accept is dropped (so the shipped default applies) instead of failing a review. An
 * explicit `null` (or blank) skill, or a `null` model, reads as "no override".
 */
export function parseStoredProjectDynamicOverrides(
  stored: unknown,
): ProjectDynamicOverrides {
  const value: ProjectDynamicPatch = {};
  if (!isPlainObject(stored)) return {};
  for (const field of PROJECT_DYNAMIC_SETTING_FIELDS) {
    if (!Object.hasOwn(stored, field)) continue;
    checkDynamicField(value, field, stored[field]);
  }
  // A stored null (or blank) skill or model is "no override", not an override of `null`.
  const overrides: ProjectDynamicOverrides = {};
  if (value.reviewKind !== undefined) overrides.reviewKind = value.reviewKind;
  if (typeof value.dynamicModel === "string")
    overrides.dynamicModel = value.dynamicModel;
  if (typeof value.reviewSkill === "string")
    overrides.reviewSkill = value.reviewSkill;
  return overrides;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isField(name: string): name is ReviewSettingField {
  return (REVIEW_SETTING_FIELDS as readonly string[]).includes(name);
}

function setField<K extends ReviewSettingField>(
  target: ReviewSettingsOverrides,
  field: K,
  value: ReviewSettings[K],
): void {
  target[field] = value;
}

function checkField<K extends ReviewSettingField>(
  target: ReviewSettingsOverrides,
  field: K,
  raw: unknown,
): ReviewSettingIssue | undefined {
  const result = FIELD_CHECKS[field](raw);
  if (!result.ok) return { field, code: result.code };
  setField(target, field, result.value as ReviewSettings[K]);
  return undefined;
}

/**
 * Validates a set of settings the way a request sends it: an object with some of the fields. A field
 * that is left out is not set (it will be inherited); a field that is there must be valid. Collects
 * every problem, so a form can mark all of them at once. The value is a new object holding only
 * checked, normalized fields.
 */
export function validateReviewSettingsPatch(input: unknown): ValidationResult {
  if (!isPlainObject(input))
    return { ok: false, issues: [{ field: "settings", code: "INVALID_TYPE" }] };
  const value: ReviewSettingsOverrides = {};
  const issues: ReviewSettingIssue[] = [];
  for (const [name, raw] of Object.entries(input)) {
    if (!isField(name)) {
      // A name is part of the input too: it is reported as unknown, under a name that is safe to show.
      issues.push({
        field: /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "settings",
        code: "UNKNOWN_FIELD",
      });
      continue;
    }
    const issue = checkField(value, name, raw);
    if (issue !== undefined) issues.push(issue);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/**
 * Reads a stored layer. Storage may hold something this version would not accept (a limit was
 * tightened, a field was removed, the text was edited by hand): such a field is dropped, so the
 * layer below applies, instead of making every review of the project fail.
 *
 * `allowedCommands` is the one field that is normalized instead of dropped: a stored list is
 * intersected with the commands that still exist (#203). An explicit empty list stays empty (an
 * explicit "no commands" must never fall back to enabling `/review`), and a list whose removed
 * entries leave nothing becomes `[]`. A missing field still inherits.
 */
export function parseStoredOverrides(stored: unknown): ReviewSettingsOverrides {
  const value: ReviewSettingsOverrides = {};
  if (!isPlainObject(stored)) return value;
  for (const field of REVIEW_SETTING_FIELDS) {
    if (!Object.hasOwn(stored, field)) continue;
    if (field === "allowedCommands") {
      const normalized = storedCommands(stored[field]);
      if (normalized !== undefined) value.allowedCommands = normalized;
      continue;
    }
    checkField(value, field, stored[field]);
  }
  return value;
}

/** A stored `allowedCommands` list intersected with the commands that still exist; order canonical. */
function storedCommands(value: unknown): ReviewCommand[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<ReviewCommand>();
  for (const entry of value) {
    const command = REVIEW_COMMANDS.find((known) => known === entry);
    if (command !== undefined) seen.add(command);
  }
  return REVIEW_COMMANDS.filter((command) => seen.has(command));
}
