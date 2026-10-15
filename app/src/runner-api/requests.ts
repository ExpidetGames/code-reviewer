// SPDX-License-Identifier: Apache-2.0

// The checks on what a runner sends. Written by hand (no schema library at run time), and kept in
// line with contracts/runner-api.v1.json by the compatibility test, which runs a set of good and bad
// bodies through both and requires the same verdict. A refusal lists fields and reasons, never
// values: the bodies of these requests hold a lease token and a log.
import type {
  StoppedEarly,
  ClaimEngine,
  ClaimFeature,
  ClaimRequest,
  CompleteRequest,
  FieldError,
  FieldErrorCode,
  HeartbeatRequest,
  ReleaseRequest,
  RunnerResult,
  RunnerUsage,
  WorkerResultRequest,
} from "./contract.ts";
import {
  CLAIM_ENGINES,
  CLAIM_FEATURES,
  MAX_RUNNING_RANGE,
  RELEASE_RETRY_AFTER_RANGE,
  STOPPED_EARLY_REASONS,
} from "./contract.ts";
import { WORKER_CREDENTIAL_PATTERN } from "../jobs/worker-credential.ts";

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
export const MAX_ERROR_REASON_CHARS = 64;
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

/**
 * The optional claim body (#195): `{ engines: [...] }`. An absent or empty body is a previous-release
 * runner and means `pr-agent` only; the caller fills that in. `engines` must hold known, unique
 * engine names; unknown or duplicated ones are refused before anything is claimed, so a runner
 * cannot talk itself into a job it cannot run.
 */
export function parseClaimRequest(body: unknown): Parsed<ClaimRequest> {
  if (body === undefined) return { ok: true, value: {} };
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  const raw = body.engines;
  let engines: ClaimEngine[] | undefined;
  if (raw === undefined) {
    engines = undefined;
  } else if (!Array.isArray(raw)) {
    check.fail("engines", "invalid");
  } else {
    const seen = new Set<string>();
    const accepted: ClaimEngine[] = [];
    if (raw.length === 0) check.fail("engines", "invalid");
    for (const entry of raw) {
      if (
        typeof entry !== "string" ||
        !CLAIM_ENGINES.some((known) => known === entry)
      ) {
        check.fail("engines", "invalid");
        continue;
      }
      if (seen.has(entry)) {
        check.fail("engines", "invalid");
        continue;
      }
      seen.add(entry);
      accepted.push(entry as ClaimEngine);
    }
    if (check.fields.length === 0) engines = accepted;
  }
  const features = parseFeatures(check, body.features);
  const jobId = parseClaimJobId(check, body.jobId);
  const maxRunning = parseMaxRunning(check, body.maxRunning);
  if (check.fields.length > 0) return { ok: false, fields: check.fields };
  return {
    ok: true,
    value: {
      ...(engines === undefined ? {} : { engines }),
      ...(features === undefined ? {} : { features }),
      ...(jobId === undefined ? {} : { jobId }),
      ...(maxRunning === undefined ? {} : { maxRunning }),
    },
  };
}

/** #322: the job a Dispatcher wants; absent means the next due job. A present value must be a UUID. */
function parseClaimJobId(check: Checker, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !JOB_ID.test(raw))
    return check.fail("jobId", "invalid");
  return raw;
}

/** #322: the pool cap; an integer from 1 to 1000. 0 is refused: a cap of 0 would refuse every claim. */
function parseMaxRunning(check: Checker, raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < MAX_RUNNING_RANGE.min ||
    raw > MAX_RUNNING_RANGE.max
  )
    return check.fail("maxRunning", "invalid");
  return raw;
}

const FEATURE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_FEATURES = 16;

/**
 * #279: what else the runner understands. Only the names this app knows are kept; an unknown one is
 * ignored, so a newer runner can name features an older app has never heard of. A list that is not a
 * list of plain names is refused like the contract does.
 */
function parseFeatures(
  check: Checker,
  raw: unknown,
): ClaimFeature[] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_FEATURES ||
    !raw.every((entry) => typeof entry === "string" && FEATURE_NAME.test(entry))
  )
    return check.fail("features", "invalid");
  return CLAIM_FEATURES.filter((known) => raw.includes(known));
}

/**
 * #322: the body of the release. The credential is checked for its form only; it is never part of a
 * refusal, which names fields and reasons. Any reason of the right form is accepted: the app maps one it
 * does not know to `launch_failed` (it is stored as the error code of a job that fails).
 */
export function parseReleaseRequest(body: unknown): Parsed<ReleaseRequest> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  const credential = body.credential;
  if (credential === undefined) check.fail("credential", "required");
  else if (
    typeof credential !== "string" ||
    !WORKER_CREDENTIAL_PATTERN.test(credential)
  )
    check.fail("credential", "invalid");
  const reason = body.reason;
  if (reason === undefined) check.fail("reason", "required");
  else if (typeof reason !== "string" || !ERROR_CODE.test(reason))
    check.fail("reason", "invalid");
  const retryAfter = body.retryAfterSeconds;
  if (
    retryAfter !== undefined &&
    (typeof retryAfter !== "number" ||
      !Number.isInteger(retryAfter) ||
      retryAfter < RELEASE_RETRY_AFTER_RANGE.min ||
      retryAfter > RELEASE_RETRY_AFTER_RANGE.max)
  )
    check.fail("retryAfterSeconds", "invalid");
  if (check.fields.length > 0) return { ok: false, fields: check.fields };
  return {
    ok: true,
    value: {
      credential: credential as string,
      reason: reason as string,
      ...(retryAfter === undefined
        ? {}
        : { retryAfterSeconds: retryAfter as number }),
    },
  };
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

function parseUsage(
  check: Checker,
  value: unknown,
): RunnerUsage | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return check.fail("result.usage", "invalid");
  const before = check.fields.length;
  const prefix = "result.usage.";
  const model =
    value.model === null
      ? null
      : check.string(value, "model", `${prefix}model`, {
          max: MAX_MODEL_CHARS,
        });
  const promptTokens = check.integer(
    value,
    "promptTokens",
    `${prefix}promptTokens`,
  );
  const completionTokens = check.integer(
    value,
    "completionTokens",
    `${prefix}completionTokens`,
  );
  const totalTokens = check.integer(
    value,
    "totalTokens",
    `${prefix}totalTokens`,
  );
  const aiCalls = check.integer(value, "aiCalls", `${prefix}aiCalls`);
  const fallbackUsed = value.fallbackUsed;
  if (typeof fallbackUsed !== "boolean")
    check.fail(`${prefix}fallbackUsed`, "invalid");
  const costUsd = value.costUsd;
  const costOk =
    costUsd === null ||
    (typeof costUsd === "number" && costUsd >= 0 && Number.isFinite(costUsd));
  if (!costOk) check.fail(`${prefix}costUsd`, "invalid");
  const stoppedEarly = value.stoppedEarly ?? null;
  const stoppedOk =
    stoppedEarly === null ||
    (typeof stoppedEarly === "string" &&
      (STOPPED_EARLY_REASONS as readonly string[]).includes(stoppedEarly));
  if (!stoppedOk) check.fail(`${prefix}stoppedEarly`, "invalid");
  if (
    check.fields.length > before ||
    model === undefined ||
    promptTokens === undefined ||
    completionTokens === undefined ||
    totalTokens === undefined ||
    aiCalls === undefined ||
    typeof fallbackUsed !== "boolean" ||
    !costOk ||
    !stoppedOk
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
    stoppedEarly: stoppedEarly as StoppedEarly | null,
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
  const errorReason = check.optionalString(
    value,
    "errorReason",
    "result.errorReason",
    MAX_ERROR_REASON_CHARS,
  );
  if (typeof errorReason === "string" && !ERROR_CODE.test(errorReason))
    check.fail("result.errorReason", "invalid");
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
  const usage = parseUsage(check, value.usage);

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
    ...(typeof errorReason === "string" ? { errorReason } : {}),
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

/** #320: the body of the Worker's result call: the result alone, the credential identifies the job. */
export function parseWorkerResultRequest(
  body: unknown,
): Parsed<WorkerResultRequest> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  const result =
    body.result === undefined
      ? check.fail("result", "required")
      : parseResult(check, body.result);
  if (check.fields.length > 0 || result === undefined)
    return { ok: false, fields: check.fields };
  return { ok: true, value: { result } };
}

/**
 * #320: the features named in the `features` query parameter of the Worker's details call, a comma
 * separated list with the same meaning as `features` of a claim. Only the names this app knows are kept;
 * anything else is ignored, so a newer Worker can name features an older app has never heard of.
 */
export function parseWorkerFeatures(raw: string | null): ClaimFeature[] {
  if (raw === null) return [];
  const names = raw.split(",").map((name) => name.trim());
  return CLAIM_FEATURES.filter((known) => names.includes(known));
}
