// SPDX-License-Identifier: Apache-2.0

// The rules for what may be stored as entitlements, shared by the repository of a workspace row and by the
// instance default. Pure. A refusal carries a stable code (and the limit it concerns); callers branch on the
// code, never on the text.
import {
  KEY_MODES,
  LIMIT_NAMES,
  type EntitlementLimits,
  type EntitlementsData,
  type KeyMode,
  type LimitName,
  type ModelAccess,
} from "./entitlements.ts";

export const ENTITLEMENT_ERROR_CODES = [
  "entitlements_invalid",
  "plan_label_invalid",
  "key_mode_invalid",
  "limits_invalid",
  "limit_invalid",
  /**
   * A managed cost limit next to the own key (#277): `managedCostLimitMicroUsd` only counts runs on the
   * operator's key, so it would be stored and never read. Refused on a write; a stored entry of that shape
   * still reads (the limit is ignored). The own key has a limit of its own, `ownKeyCostLimitMicroUsd` (#361).
   */
  "cost_limit_requires_managed_key",
  "period_start_invalid",
  "period_start_in_future",
  "period_start_backwards",
  "suspended_invalid",
  "suspension_code_invalid",
  /** #428: the model access is not `{ catalogEntries }` with null or at most 100 catalog entry ids. */
  "catalog_entry_invalid",
] as const;
export type EntitlementErrorCode = (typeof ENTITLEMENT_ERROR_CODES)[number];

export const PLAN_LABEL_MAX_LENGTH = 64;
export const SUSPENSION_CODE_MAX_LENGTH = 64;
/** The most entries a model access may list (#428). */
export const MODEL_ACCESS_MAX_ENTRIES = 100;
/**
 * What an id of the model access looks like: the prefix of a catalog entry id and opaque text. Only the shape is checked;
 * whether an entry with that id exists is not (an unknown id matches nothing).
 */
export const CATALOG_ENTRY_ID_PATTERN = /^mce_[A-Za-z0-9_-]{1,64}$/;
/** A clock that runs a little ahead is fine; a reset dated further ahead is a mistake. */
export const PERIOD_START_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Limits that were added after the first release of the table. A stored entry written before one existed
 * lacks its key; reading it must not make the entry unreadable, and no limit existed then, so the missing key
 * reads as `null` (unlimited). Adding a limit means: add it to LIMIT_NAMES (entitlements.ts) and to this
 * list. Writes still require every key (a caller states every limit explicitly). The three first limits are
 * not on the list: every entry has them.
 */
export const LIMITS_ADDED_LATER: readonly LimitName[] = [
  "ownKeyCostLimitMicroUsd", // #361
];

const SUSPENSION_CODE_PATTERN = /^[a-z][a-z0-9_-]*$/;
// What a label may not contain: control characters (C0, C1, DEL), formatting characters (zero width joiners,
// bidirectional overrides), private use and surrogate code points, and the Unicode line and paragraph
// separators. Unassigned code points (Cn) are deliberately not listed: whether one is assigned depends on the
// Unicode version of the runtime, and a check must not give another answer on another Node.
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
// What shows nothing: spaces (also the no-break space), combining marks, and the letters and symbols that
// are blank by design (Hangul fillers, the blank braille pattern, the Mongolian vowel separator).
const SHOWS_NOTHING = /[\p{Z}\p{M}\u115f\u1160\u180e\u2800\u3164\uffa0]/u;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type EntitlementsValidation =
  | { ok: true; value: EntitlementsData }
  | { ok: false; code: EntitlementErrorCode; field?: string };

/** The error a repository throws for a refusal, so a caller can map the code. */
export class EntitlementsError extends Error {
  readonly code: EntitlementErrorCode;
  readonly field?: string;

  constructor(code: EntitlementErrorCode, field?: string) {
    super(field === undefined ? code : `${code} (${field})`);
    this.name = "EntitlementsError";
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKeyMode(value: unknown): value is KeyMode {
  return KEY_MODES.some((mode) => mode === value);
}

function isValidPlanLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const characters = [...value];
  if (characters.length < 1 || characters.length > PLAN_LABEL_MAX_LENGTH)
    return false;
  if (NOT_PRINTABLE.test(value)) return false;
  return characters.some((character) => !SHOWS_NOTHING.test(character));
}

type LimitsValidation =
  | { ok: true; value: EntitlementLimits }
  | { ok: false; code: "limits_invalid" | "limit_invalid"; field?: string };

/**
 * Checks the limits: an object with a count or null for every limit. `optional` names the limits whose
 * absence is fine and reads as null; `allowUnknownKeys` (reading only) ignores keys of a newer version
 * instead of refusing them, which on a write catches typos such as `diffRunPerPeriod`.
 */
export function validateLimits(
  value: unknown,
  optional: readonly LimitName[] = [],
  allowUnknownKeys = false,
): LimitsValidation {
  if (!isRecord(value)) return { ok: false, code: "limits_invalid" };
  const known: readonly string[] = LIMIT_NAMES;
  if (
    !allowUnknownKeys &&
    Object.keys(value).some((key) => !known.includes(key))
  )
    return { ok: false, code: "limits_invalid" };
  const limits: Partial<EntitlementLimits> = {};
  for (const name of LIMIT_NAMES) {
    if (!(name in value) && optional.includes(name)) {
      limits[name] = null;
      continue;
    }
    if (!(name in value)) return { ok: false, code: "limits_invalid" };
    const limit = value[name];
    const valid =
      limit === null ||
      (typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0);
    if (!valid) return { ok: false, code: "limit_invalid", field: name };
    limits[name] = limit;
  }
  return { ok: true, value: limits as EntitlementLimits };
}

/**
 * The canonical text (ISO 8601 UTC, milliseconds) of a time given as UTC text, or undefined when it is not
 * one. A day that does not exist ("02-31") is refused, not rolled over.
 */
function canonicalUtcTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !UTC_TIME.test(value)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const calendarDay = value.slice(0, 10);
  if (date.toISOString().slice(0, 10) !== calendarDay) return undefined;
  return date.toISOString();
}

const ENTITLEMENT_KEYS = [
  "planLabel",
  "keyMode",
  "limits",
  "periodStart",
  "suspended",
  "suspensionCode",
  "modelAccess",
] as const;

type ModelAccessValidation =
  | { ok: true; value: ModelAccess }
  | { ok: false; field: string };

/**
 * Checks `{ catalogEntries }`: null or a list of at most 100 id-shaped strings. A missing field is every released
 * entry. A write refuses a key it does not know; reading ignores it (a newer app wrote it). Damaged data is refused
 * when reading too, so the entry is unreadable and grants nothing.
 */
function checkModelAccess(
  value: unknown,
  reading: boolean,
): ModelAccessValidation {
  if (value === undefined) return { ok: true, value: { catalogEntries: null } };
  if (!isRecord(value)) return { ok: false, field: "modelAccess" };
  if (!reading && Object.keys(value).some((key) => key !== "catalogEntries"))
    return { ok: false, field: "modelAccess" };
  const listed = value.catalogEntries;
  if (listed === null) return { ok: true, value: { catalogEntries: null } };
  const field = "modelAccess.catalogEntries";
  if (!Array.isArray(listed) || listed.length > MODEL_ACCESS_MAX_ENTRIES)
    return { ok: false, field };
  const ids: string[] = [];
  for (const id of listed as unknown[]) {
    if (typeof id !== "string" || !CATALOG_ENTRY_ID_PATTERN.test(id))
      return { ok: false, field };
    ids.push(id);
  }
  return { ok: true, value: { catalogEntries: ids } };
}

type CheckMode = { reading: false; now: Date } | { reading: true };

function check(input: unknown, mode: CheckMode): EntitlementsValidation {
  if (!isRecord(input)) return { ok: false, code: "entitlements_invalid" };
  if (!mode.reading) {
    const known: readonly string[] = ENTITLEMENT_KEYS;
    const unknown = Object.keys(input).find((key) => !known.includes(key));
    if (unknown !== undefined)
      return { ok: false, code: "entitlements_invalid", field: unknown };
  }

  if (!isValidPlanLabel(input.planLabel))
    return { ok: false, code: "plan_label_invalid" };
  if (!isKeyMode(input.keyMode)) return { ok: false, code: "key_mode_invalid" };

  const limits = mode.reading
    ? validateLimits(input.limits, LIMITS_ADDED_LATER, true)
    : validateLimits(input.limits);
  if (!limits.ok)
    return limits.field === undefined
      ? { ok: false, code: limits.code }
      : { ok: false, code: limits.code, field: limits.field };

  if (
    !mode.reading &&
    input.keyMode === "own" &&
    limits.value.managedCostLimitMicroUsd !== null
  )
    return {
      ok: false,
      code: "cost_limit_requires_managed_key",
      field: "managedCostLimitMicroUsd",
    };

  const periodStart = canonicalUtcTime(input.periodStart);
  if (periodStart === undefined)
    return { ok: false, code: "period_start_invalid" };
  if (
    !mode.reading &&
    new Date(periodStart).getTime() >
      mode.now.getTime() + PERIOD_START_FUTURE_TOLERANCE_MS
  )
    return { ok: false, code: "period_start_in_future" };

  if (typeof input.suspended !== "boolean")
    return { ok: false, code: "suspended_invalid" };
  // The code is checked whether or not the workspace is suspended: garbage is a client bug, not something
  // to drop silently.
  let suspensionCode: string | null = null;
  if (input.suspensionCode !== null && input.suspensionCode !== undefined) {
    const code = input.suspensionCode;
    const valid =
      typeof code === "string" &&
      code.length <= SUSPENSION_CODE_MAX_LENGTH &&
      SUSPENSION_CODE_PATTERN.test(code);
    if (!valid) return { ok: false, code: "suspension_code_invalid" };
    suspensionCode = code;
  }
  if (!input.suspended && suspensionCode !== null) {
    // A valid code on a workspace that is not suspended: written, the suspension is cleared together with its
    // code; stored, such an entry cannot exist (the table refuses it), so it is not readable.
    if (mode.reading) return { ok: false, code: "suspension_code_invalid" };
    suspensionCode = null;
  }

  // Last, so that an entry that was refused before #428 is refused for the same reason as before.
  const modelAccess = checkModelAccess(input.modelAccess, mode.reading);
  if (!modelAccess.ok)
    return {
      ok: false,
      code: "catalog_entry_invalid",
      field: modelAccess.field,
    };

  return {
    ok: true,
    value: {
      planLabel: input.planLabel,
      keyMode: input.keyMode,
      limits: limits.value,
      periodStart,
      suspended: input.suspended,
      suspensionCode,
      modelAccess: modelAccess.value,
    },
  };
}

/**
 * Checks the input of an operator (or a repository caller) and returns it in the form that is stored. The
 * label has to be printable and show something, no key may be unknown, every limit present and a count or
 * null, the period start a UTC time that is not more than a few minutes ahead of `now`. A valid suspension
 * code is kept only while suspended: clearing the suspension clears the code with it.
 */
export function validateEntitlements(
  input: unknown,
  now: Date,
): EntitlementsValidation {
  return check(input, { reading: false, now });
}

/**
 * Reads a stored entry (the decoded JSON of the default, or the columns of a row put together): the same rules
 * as a write, except that the clock is not asked, a key it does not know is ignored (an older app reads what
 * a newer one wrote) and a limit on LIMITS_ADDED_LATER may be missing. Undefined means unreadable; the
 * caller resolves that to `invalid`, never to "no limits".
 */
export function readEntitlements(input: unknown): EntitlementsData | undefined {
  const result = check(input, { reading: true });
  return result.ok ? result.value : undefined;
}

/**
 * A period start never moves to an earlier time than the stored one, so a repeated or late reset is harmless.
 * The same value again is fine. Both are canonical texts (fixed width), so they compare as text.
 */
export function checkPeriodStartNotBackwards(
  next: string,
  stored: string | undefined,
): "period_start_backwards" | undefined {
  if (stored !== undefined && next < stored) return "period_start_backwards";
  return undefined;
}
