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
} from "./entitlements.ts";

export const ENTITLEMENT_ERROR_CODES = [
  "entitlements_invalid",
  "plan_label_invalid",
  "key_mode_invalid",
  "limits_invalid",
  "limit_invalid",
  "period_start_invalid",
  "period_start_in_future",
  "period_start_backwards",
  "suspended_invalid",
  "suspension_code_invalid",
] as const;
export type EntitlementErrorCode = (typeof ENTITLEMENT_ERROR_CODES)[number];

export const PLAN_LABEL_MAX_LENGTH = 64;
export const SUSPENSION_CODE_MAX_LENGTH = 64;
/** A clock that runs a little ahead is fine; a reset dated further ahead is a mistake. */
export const PERIOD_START_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const SUSPENSION_CODE_PATTERN = /^[a-z][a-z0-9_-]*$/;
// Control characters (C0, C1, DEL), formatting characters (zero width joiners, bidirectional overrides),
// the Unicode line separators and unassigned or private use code points: nothing a label should hide in.
const NOT_PRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;
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
  const length = [...value].length;
  return (
    length >= 1 && length <= PLAN_LABEL_MAX_LENGTH && !NOT_PRINTABLE.test(value)
  );
}

type LimitsValidation =
  | { ok: true; value: EntitlementLimits }
  | { ok: false; code: "limits_invalid" | "limit_invalid"; field?: string };

function validateLimits(value: unknown): LimitsValidation {
  if (!isRecord(value)) return { ok: false, code: "limits_invalid" };
  const known: readonly string[] = LIMIT_NAMES;
  if (Object.keys(value).some((key) => !known.includes(key)))
    return { ok: false, code: "limits_invalid" };
  if (LIMIT_NAMES.some((name) => !(name in value)))
    return { ok: false, code: "limits_invalid" };
  const limits: Partial<EntitlementLimits> = {};
  for (const name of LIMIT_NAMES) {
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

/**
 * Checks the input of an operator (or a repository caller) and returns it in the form that is stored. The
 * label has to be printable, every limit present and a count or null, the period start a UTC time that is not
 * more than a few minutes ahead of `now`. A suspension code is kept only while suspended: clearing the
 * suspension clears the code with it.
 */
export function validateEntitlements(
  input: unknown,
  now: Date,
): EntitlementsValidation {
  if (!isRecord(input)) return { ok: false, code: "entitlements_invalid" };

  if (!isValidPlanLabel(input.planLabel))
    return { ok: false, code: "plan_label_invalid" };
  if (!isKeyMode(input.keyMode)) return { ok: false, code: "key_mode_invalid" };

  const limits = validateLimits(input.limits);
  if (!limits.ok)
    return limits.field === undefined
      ? { ok: false, code: limits.code }
      : { ok: false, code: limits.code, field: limits.field };

  const periodStart = canonicalUtcTime(input.periodStart);
  if (periodStart === undefined)
    return { ok: false, code: "period_start_invalid" };
  if (
    new Date(periodStart).getTime() >
    now.getTime() + PERIOD_START_FUTURE_TOLERANCE_MS
  )
    return { ok: false, code: "period_start_in_future" };

  if (typeof input.suspended !== "boolean")
    return { ok: false, code: "suspended_invalid" };
  let suspensionCode: string | null = null;
  if (
    input.suspended &&
    input.suspensionCode !== null &&
    input.suspensionCode !== undefined
  ) {
    const code = input.suspensionCode;
    const valid =
      typeof code === "string" &&
      code.length <= SUSPENSION_CODE_MAX_LENGTH &&
      SUSPENSION_CODE_PATTERN.test(code);
    if (!valid) return { ok: false, code: "suspension_code_invalid" };
    suspensionCode = code;
  }

  return {
    ok: true,
    value: {
      planLabel: input.planLabel,
      keyMode: input.keyMode,
      limits: limits.value,
      periodStart,
      suspended: input.suspended,
      suspensionCode,
    },
  };
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
