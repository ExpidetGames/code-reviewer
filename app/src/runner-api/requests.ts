// The checks on what a runner sends. Written by hand (no schema library at run time), and kept in
// line with contracts/runner-api.v1.json by the compatibility test, which runs a set of good and bad
// bodies through both and requires the same verdict. A refusal lists fields and reasons, never
// values: the bodies of these requests hold a lease token and a log.
import type {
  CompleteRequest,
  FieldError,
  FieldErrorCode,
  HeartbeatRequest,
  RunnerResult,
  RunnerUsage,
} from "./contract.ts";

export type Parsed<T> =
  { ok: true; value: T } | { ok: false; fields: FieldError[] };

const JOB_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** The id used when a runner sends no `X-Runner-Id`; the id is for bookkeeping only. */
export const UNKNOWN_RUNNER_ID = "unknown";

export const LEASE_TOKEN_LENGTH = { min: 8, max: 256 } as const;
export const MAX_LOG_TAIL_CHARS = 8192;
export const MAX_ERROR_MESSAGE_CHARS = 2000;
export const MAX_COMMENT_URL_CHARS = 2048;
export const MAX_DURATION_MS = 604_800_000;
const MAX_MODEL_CHARS = 200;

export function parseJobId(value: string): boolean {
  return JOB_ID.test(value);
}

/** The runner id of the `X-Runner-Id` header (null when it is absent). */
export function parseRunnerId(header: string | null): Parsed<string> {
  if (header === null) return { ok: true, value: UNKNOWN_RUNNER_ID };
  if (!RUNNER_ID.test(header))
    return { ok: false, fields: [{ field: "X-Runner-Id", code: "invalid" }] };
  return { ok: true, value: header };
}

type Record_ = Record<string, unknown>;

/** The length JSON Schema counts: characters (code points), not UTF-16 units. */
function lengthOf(value: string): number {
  return [...value].length;
}

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects the refusals of one body while its fields are checked. */
class Checker {
  readonly fields: FieldError[] = [];

  fail(field: string, code: FieldErrorCode): undefined {
    this.fields.push({ field, code });
    return undefined;
  }

  string(
    source: Record_,
    key: string,
    field: string,
    options: { min?: number; max: number },
  ): string | undefined {
    const value = source[key];
    if (value === undefined) return this.fail(field, "required");
    if (typeof value !== "string") return this.fail(field, "invalid");
    const length = lengthOf(value);
    if (length > options.max) return this.fail(field, "too_long");
    if (length < (options.min ?? 0)) return this.fail(field, "invalid");
    return value;
  }

  /** A string that may be null or left out; `fallback` is what a missing value becomes. */
  optionalString(
    source: Record_,
    key: string,
    field: string,
    max: number,
  ): string | null | undefined {
    const value = source[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return this.fail(field, "invalid");
    if (lengthOf(value) > max) return this.fail(field, "too_long");
    return value;
  }

  integer(
    source: Record_,
    key: string,
    field: string,
    max = Number.MAX_SAFE_INTEGER,
  ): number | undefined {
    const value = source[key];
    if (value === undefined) return this.fail(field, "required");
    if (
      !Number.isInteger(value) ||
      (value as number) < 0 ||
      (value as number) > max
    )
      return this.fail(field, "invalid");
    return value as number;
  }
}

function leaseTokenOf(check: Checker, body: Record_): string | undefined {
  return check.string(body, "leaseToken", "leaseToken", {
    min: LEASE_TOKEN_LENGTH.min,
    max: LEASE_TOKEN_LENGTH.max,
  });
}

export function parseHeartbeatRequest(body: unknown): Parsed<HeartbeatRequest> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  const leaseToken = leaseTokenOf(check, body);
  if (check.fields.length > 0 || leaseToken === undefined)
    return { ok: false, fields: check.fields };
  return { ok: true, value: { leaseToken } };
}

function parseUsage(value: unknown): RunnerUsage | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const check = new Checker();
  const model =
    value.model === null
      ? null
      : check.string(value, "model", "model", { max: MAX_MODEL_CHARS });
  const promptTokens = check.integer(value, "promptTokens", "promptTokens");
  const completionTokens = check.integer(
    value,
    "completionTokens",
    "completionTokens",
  );
  const totalTokens = check.integer(value, "totalTokens", "totalTokens");
  const aiCalls = check.integer(value, "aiCalls", "aiCalls");
  const fallbackUsed = value.fallbackUsed;
  if (typeof fallbackUsed !== "boolean") check.fail("fallbackUsed", "invalid");
  const costUsd = value.costUsd;
  const costOk =
    costUsd === null ||
    (typeof costUsd === "number" && costUsd >= 0 && Number.isFinite(costUsd));
  if (!costOk) check.fail("costUsd", "invalid");
  if (
    check.fields.length > 0 ||
    model === undefined ||
    promptTokens === undefined ||
    completionTokens === undefined ||
    totalTokens === undefined ||
    aiCalls === undefined ||
    typeof fallbackUsed !== "boolean" ||
    !costOk
  )
    return undefined;
  return {
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    aiCalls,
    fallbackUsed,
    costUsd: costUsd as number | null,
  };
}

function parseResult(check: Checker, value: unknown): RunnerResult | undefined {
  if (!isRecord(value)) return check.fail("result", "invalid");
  const before = check.fields.length;

  const ok = value.ok;
  if (ok === undefined) check.fail("result.ok", "required");
  else if (typeof ok !== "boolean") check.fail("result.ok", "invalid");
  const durationMs = check.integer(
    value,
    "durationMs",
    "result.durationMs",
    MAX_DURATION_MS,
  );
  const logTail = check.string(value, "logTail", "result.logTail", {
    max: MAX_LOG_TAIL_CHARS,
  });
  const errorMessage = check.optionalString(
    value,
    "errorMessage",
    "result.errorMessage",
    MAX_ERROR_MESSAGE_CHARS,
  );
  const commentUrl = check.optionalString(
    value,
    "commentUrl",
    "result.commentUrl",
    MAX_COMMENT_URL_CHARS,
  );
  if (typeof commentUrl === "string" && !/^https?:\/\//.test(commentUrl))
    check.fail("result.commentUrl", "invalid");

  // `errorCode` has to be given (as null for a good run) and must agree with `ok`.
  const errorCode = value.errorCode;
  if (errorCode === undefined) check.fail("result.errorCode", "required");
  else if (
    errorCode !== null &&
    (typeof errorCode !== "string" || !ERROR_CODE.test(errorCode))
  )
    check.fail("result.errorCode", "invalid");
  else if (
    typeof ok === "boolean" &&
    (ok ? errorCode !== null : errorCode === null)
  )
    check.fail("result.errorCode", "invalid");

  const logTruncated = value.logTruncated;
  if (logTruncated !== undefined && typeof logTruncated !== "boolean")
    check.fail("result.logTruncated", "invalid");
  const usage = parseUsage(value.usage);
  if (usage === undefined) check.fail("result.usage", "invalid");

  if (
    check.fields.length > before ||
    typeof ok !== "boolean" ||
    durationMs === undefined ||
    logTail === undefined ||
    errorMessage === undefined ||
    commentUrl === undefined ||
    usage === undefined ||
    (errorCode !== null && typeof errorCode !== "string")
  )
    return undefined;
  return {
    ok,
    durationMs,
    commentUrl,
    errorCode,
    errorMessage,
    logTail,
    logTruncated: logTruncated === true,
    usage,
  };
}

export function parseCompleteRequest(body: unknown): Parsed<CompleteRequest> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  const leaseToken = leaseTokenOf(check, body);
  const result =
    body.result === undefined
      ? check.fail("result", "required")
      : parseResult(check, body.result);
  if (
    check.fields.length > 0 ||
    leaseToken === undefined ||
    result === undefined
  )
    return { ok: false, fields: check.fields };
  return { ok: true, value: { leaseToken, result } };
}
