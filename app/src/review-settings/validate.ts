// SPDX-License-Identifier: LicenseRef-Proprietary

// Checks review settings that come from outside (a request body) or from storage. Pure: no database,
// no environment. Every problem is reported as `{ field, code }` with a stable code; the message a
// person reads is the UI's business, and a value is never echoed back.
import { REVIEW_COMMANDS, type ReviewCommand } from "../integrations/types.ts";
import type { LlmProvider } from "../llm/config.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import {
  isCatalogModelId,
  nativeProviderIdOf,
} from "../native-cost/catalog-ref.ts";
import {
  PROJECT_CATALOG_FIELDS,
  PROJECT_DYNAMIC_LIMITS,
  PROVIDER_ADDRESS_MAX_LENGTH,
  PROJECT_DYNAMIC_SETTING_FIELDS,
  REVIEW_VERDICT_MODES,
  type ReviewVerdictMode,
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
  /**
   * The provider's model metadata lists no endpoint with both `tools` and `tool_choice` for the Dynamic model
   * of a save; Dynamic Review needs tool calling (#269). Never reported by the validation itself.
   */
  "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
  /** The provider has no such model (#269). Never reported by the validation itself. */
  "DYNAMIC_MODEL_UNKNOWN",
  /**
   * The write sets a model field (`model`, `fallbackModel`, `dynamicModel`) for a workspace on the operator's key,
   * whose models are the operator's (#283). Never reported by the validation itself.
   */
  "MODEL_MANAGED_BY_INSTANCE",
  /** The provider is not one of the registry (#430). */
  "PROVIDER_UNKNOWN",
  /**
   * The person confirms the address of the project's catalog provider (#588) and there is none to confirm: the project selects
   * no catalog provider, or the catalog trusts no address for it now. Never reported by the validation itself.
   */
  "PROVIDER_ADDRESS_NOT_PINNABLE",
  /**
   * The catalog entry checks of a project save in a workspace on the operator's key (#430). Never reported by the
   * validation itself: they need the catalog. There is no such entry.
   */
  "CATALOG_ENTRY_UNKNOWN",
  /** The entry is a draft or retired: only a released entry may be chosen. */
  "CATALOG_ENTRY_NOT_RELEASED",
  /** The entry does not serve the review kind of the setting (a Diff-only entry for Dynamic). */
  "CATALOG_ENTRY_KIND_MISMATCH",
  /** The workspace's plan does not allow the entry (`modelAccess`). */
  "CATALOG_ENTRY_NOT_ALLOWED",
  /**
   * The workspace uses its own key, which never reads the catalog: a catalog entry is refused rather than stored
   * unchecked (#430).
   */
  "CATALOG_ENTRY_OWN_KEY_MODE",
  /**
   * A provider and a model of different layers do not belong together: a project sets another provider while the
   * workspace default holds a model of the first (or the workspace default changes under such a project). The claim fails
   * such a job closed; the save refuses it so the user does not find out only when a job fails (#432). Own key mode only.
   * Never reported by the validation itself.
   */
  "MODEL_PROVIDER_MISMATCH",
  /**
   * The Dynamic provider is a catalog provider (#555) and the model is not one the catalog lists for it: unknown, released since
   * the last daily fetch, or no longer listed. Never reported by the validation itself: it needs the catalog.
   */
  "MODEL_NOT_IN_CATALOG",
] as const;
export type ReviewSettingIssueCode =
  (typeof REVIEW_SETTING_ISSUE_CODES)[number];

export const REVIEW_SETTING_WARNING_CODES = [
  /**
   * The Dynamic model of a save could not be checked against the provider's metadata (unreachable, slow, an
   * answer that could not be read). The save went through; the run-time check still applies (#269).
   */
  "DYNAMIC_MODEL_UNVERIFIED",
] as const;
export type ReviewSettingWarningCode =
  (typeof REVIEW_SETTING_WARNING_CODES)[number];

/** A note on a save that succeeded. */
export type ReviewSettingWarning = {
  field: ReviewSettingIssue["field"];
  code: ReviewSettingWarningCode;
};

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

/**
 * Where a provider id is looked up: the registry of the app, or one a test builds with a second provider. `find` is
 * trimmed and case-insensitive (`ProviderRegistry.find`).
 */
export type ProviderLookup = {
  readonly defaultProvider: { readonly id: string };
  find(
    raw: unknown,
  ): { readonly id: string; checkModelId(id: string): boolean } | undefined;
};

/** What the checks of one request need: the lookup, and the model-id rule of the provider of each model. */
type CheckContext = {
  providers: ProviderLookup;
  /** The rule of the provider of `model` and `fallbackModel`. */
  diffModelRule: (id: string) => boolean;
  /** The rule of the provider of `dynamicModel`. */
  dynamicModelRule: (id: string) => boolean;
};

/**
 * The rule a model is held to is the one of the provider the same input names (`provider` for the Diff models,
 * `dynamicProvider` for the Dynamic one), else the default provider's: a model is only meaningful at its provider.
 */
function contextFor(input: unknown, providers: ProviderLookup): CheckContext {
  const named = (field: "provider" | "dynamicProvider") => {
    const raw = isPlainObject(input) ? input[field] : undefined;
    const found = typeof raw === "string" ? providers.find(raw) : undefined;
    // The Dynamic provider may be a catalog provider (#555): its model is held to the shape a job entry carries.
    if (
      found === undefined &&
      field === "dynamicProvider" &&
      nativeDynamicProvider(raw) !== undefined
    )
      return isCatalogModelId;
    const provider = found ?? providers.find(providers.defaultProvider.id);
    return (id: string) => provider?.checkModelId(id) ?? false;
  };
  return {
    providers,
    diffModelRule: named("provider"),
    dynamicModelRule: named("dynamicProvider"),
  };
}

function modelName(
  value: unknown,
  rule: (id: string) => boolean,
): FieldResult<string> {
  if (typeof value !== "string") return fail("INVALID_TYPE");
  const name = value.trim();
  if (name === "") return fail("EMPTY");
  if (!rule(name)) return fail("INVALID_FORMAT");
  return ok(name);
}

function fallbackModel(
  value: unknown,
  context: CheckContext,
): FieldResult<string | null> {
  if (value === null) return ok(null);
  if (typeof value === "string" && value.trim() === "") return ok(null);
  return modelName(value, context.diffModelRule);
}

/** A provider of the registry, stored by its id; a spelling with other case or spaces is normalized. */
function providerId(
  value: unknown,
  context: CheckContext,
): FieldResult<LlmProvider> {
  if (typeof value !== "string") return fail("INVALID_TYPE");
  if (value.trim() === "") return fail("EMPTY");
  const found = context.providers.find(value);
  // The registry's ids are the values of `LlmProvider`; a test registry with another provider is cast the same way.
  return found === undefined
    ? fail("PROVIDER_UNKNOWN")
    : ok(found.id as LlmProvider);
}

/** The most characters of a catalog entry id; the ids of the catalog are 36 (`mce_` and 32 hex digits). */
const CATALOG_ENTRY_ID_MAX_CHARS = 64;
const CATALOG_ENTRY_ID_SHAPE = /^[A-Za-z0-9_-]+$/;

/** The id of a catalog entry, or `null` to clear the selection. Its existence is the service's check (#430). */
function catalogEntryId(value: unknown): FieldResult<string | null> {
  if (value === null) return ok(null);
  if (typeof value !== "string") return fail("INVALID_TYPE");
  if (value.trim() === "") return fail("EMPTY");
  if (value.length > CATALOG_ENTRY_ID_MAX_CHARS) return fail("TOO_LONG");
  if (!CATALOG_ENTRY_ID_SHAPE.test(value)) return fail("INVALID_FORMAT");
  return ok(value);
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
  [K in ReviewSettingField]: (
    value: unknown,
    context: CheckContext,
  ) => FieldResult<ReviewSettings[K]>;
} = {
  provider: providerId,
  model: (value, context) => modelName(value, context.diffModelRule),
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
  // A limit is a number; "no limit" is the absence of the field (the workspace default applies), never a stored null.
  maxCostCents: integerBetween(
    REVIEW_SETTING_LIMITS.maxCostCents.min,
    REVIEW_SETTING_LIMITS.maxCostCents.max,
  ),
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

/** The verdict mode of a project (#405): one of the known modes, or `null` to clear the override. */
function reviewVerdict(value: unknown): FieldResult<ReviewVerdictMode | null> {
  if (value === null) return ok(null);
  if (typeof value !== "string") return fail("INVALID_TYPE");
  const known = REVIEW_VERDICT_MODES.find((mode) => mode === value);
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
function dynamicModelValue(
  value: unknown,
  context: CheckContext,
): FieldResult<string | null> {
  if (value === null) return ok(null);
  return modelName(value, context.dynamicModelRule);
}

/**
 * The catalog provider (#555) a Dynamic provider names, by its slug as the request wrote it (trimmed, any case), or
 * undefined. A provider of the registry is not one (it keeps its own path until #556); an excluded or unknown one is not.
 */
function nativeDynamicProvider(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const slug = raw.trim().toLowerCase();
  return nativeProviderIdOf(slug, llmProviderDescriptors.ids) === null
    ? undefined
    : slug;
}

/**
 * The Dynamic provider of a project save, or `null` to clear the override so the default provider applies (#430). A provider
 * of the registry, or (#555) a catalog provider by its slug. Whether the catalog offers it is the service's question.
 */
function dynamicProviderValue(
  value: unknown,
  context: CheckContext,
): FieldResult<string | null> {
  if (value === null) return ok(null);
  const registered = providerId(value, context);
  if (registered.ok) return registered;
  const native = nativeDynamicProvider(value);
  return native === undefined ? registered : ok(native);
}

/** The action of a project save that pins the address the catalog trusts now (#588); not a stored field. */
export const CONFIRM_PROVIDER_ADDRESS = "confirmProviderAddress";

const DYNAMIC_FIELD_CHECKS: {
  [K in ProjectDynamicSettingField]: (
    value: unknown,
    context: CheckContext,
  ) => FieldResult<ProjectDynamicPatch[K]>;
} = {
  reviewKind: (value) => reviewKind(value),
  // The same rule as the Diff model: the identifier is kept literally, no provider rewrite (#194-T08).
  dynamicModel: dynamicModelValue,
  dynamicProvider: dynamicProviderValue,
  catalogEntryDiff: catalogEntryId,
  catalogEntryDynamic: catalogEntryId,
  reviewSkill: (value) => reviewSkill(value),
  reviewVerdict: (value) => reviewVerdict(value),
};

export type ProjectSettingsPatch = {
  review: ReviewSettingsOverrides;
  dynamic: ProjectDynamicPatch;
  /**
   * The person confirms the address the catalog trusts for the project's catalog provider now (#588): the pinned address is
   * written anew. Not a setting, an action; present only when the request said `true`.
   */
  confirmProviderAddress?: true;
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
  context: CheckContext,
): ReviewSettingIssue | undefined {
  const result = DYNAMIC_FIELD_CHECKS[field](raw, context);
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
  providers: ProviderLookup = llmProviderDescriptors,
): ProjectValidationResult {
  if (!isPlainObject(input))
    return { ok: false, issues: [{ field: "settings", code: "INVALID_TYPE" }] };
  const context = contextFor(input, providers);
  const review: ReviewSettingsOverrides = {};
  const dynamic: ProjectDynamicPatch = {};
  const issues: ReviewSettingIssue[] = [];
  let confirmProviderAddress = false;
  for (const [name, raw] of Object.entries(input)) {
    if (name === CONFIRM_PROVIDER_ADDRESS) {
      if (raw === true) confirmProviderAddress = true;
      else if (raw !== false)
        issues.push({ field: name, code: "INVALID_TYPE" });
      continue;
    }
    if (isProjectDynamicField(name)) {
      const issue = checkDynamicField(dynamic, name, raw, context);
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
    const issue = checkField(review, name, raw, context);
    if (issue !== undefined) issues.push(issue);
  }
  return issues.length > 0
    ? { ok: false, issues }
    : {
        ok: true,
        value: {
          review,
          dynamic,
          ...(confirmProviderAddress ? { confirmProviderAddress: true } : {}),
        },
      };
}

/**
 * Reads the project-only fields of a stored layer. Like `parseStoredOverrides`, a field this version
 * would not accept is dropped (so the shipped default applies) instead of failing a review. An
 * explicit `null` (or blank) skill, or a `null` model, reads as "no override".
 */
export function parseStoredProjectDynamicOverrides(
  stored: unknown,
  providers: ProviderLookup = llmProviderDescriptors,
): ProjectDynamicOverrides {
  const value: ProjectDynamicPatch = {};
  if (!isPlainObject(stored)) return {};
  const context = contextFor(stored, providers);
  for (const field of PROJECT_DYNAMIC_SETTING_FIELDS) {
    if (!Object.hasOwn(stored, field)) continue;
    checkDynamicField(value, field, stored[field], context);
  }
  // A stored null (or blank) skill or model is "no override", not an override of `null`.
  const overrides: ProjectDynamicOverrides = {};
  if (value.reviewKind !== undefined) overrides.reviewKind = value.reviewKind;
  if (typeof value.dynamicModel === "string")
    overrides.dynamicModel = value.dynamicModel;
  if (typeof value.reviewSkill === "string")
    overrides.reviewSkill = value.reviewSkill;
  if (typeof value.reviewVerdict === "string")
    overrides.reviewVerdict = value.reviewVerdict;
  if (typeof value.dynamicProvider === "string")
    overrides.dynamicProvider = value.dynamicProvider;
  for (const field of PROJECT_CATALOG_FIELDS) {
    const entry = value[field];
    if (typeof entry === "string") overrides[field] = entry;
  }
  // The pin (#588) is the server's: it is read from storage only. Whether it is the one canonical spelling is the claim's
  // judgement (it compares it with the address the catalog trusts); here a shape that no address of a catalog provider has is dropped.
  const pinned = stored.dynamicProviderAddress;
  if (
    typeof pinned === "string" &&
    pinned.startsWith("https://") &&
    pinned.length <= PROVIDER_ADDRESS_MAX_LENGTH
  )
    overrides.dynamicProviderAddress = pinned;
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
  context: CheckContext,
): ReviewSettingIssue | undefined {
  const result = FIELD_CHECKS[field](raw, context);
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
export function validateReviewSettingsPatch(
  input: unknown,
  providers: ProviderLookup = llmProviderDescriptors,
): ValidationResult {
  if (!isPlainObject(input))
    return { ok: false, issues: [{ field: "settings", code: "INVALID_TYPE" }] };
  const context = contextFor(input, providers);
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
    const issue = checkField(value, name, raw, context);
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
export function parseStoredOverrides(
  stored: unknown,
  providers: ProviderLookup = llmProviderDescriptors,
): ReviewSettingsOverrides {
  const value: ReviewSettingsOverrides = {};
  if (!isPlainObject(stored)) return value;
  const context = contextFor(stored, providers);
  for (const field of REVIEW_SETTING_FIELDS) {
    if (!Object.hasOwn(stored, field)) continue;
    if (field === "allowedCommands") {
      const normalized = storedCommands(stored[field]);
      if (normalized !== undefined) value.allowedCommands = normalized;
      continue;
    }
    checkField(value, field, stored[field], context);
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
