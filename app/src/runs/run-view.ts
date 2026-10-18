// SPDX-License-Identifier: Apache-2.0

// What the pages and the polling endpoint know about a run: plain data worked out from a stored job.
// This is the boundary between the database row and the browser. Only fields listed here leave the
// server: the lease token, the runner id, the delivery id, the heartbeat and the lease times are not
// among them, and of the stored result only the comment link and the log tail are read. Everything
// that came from outside (the question of an `/ask`, a login, the log of the runner) is data and is
// rendered as text; the one link made from stored data is checked here.
import { maskProvidersInText } from "../llm/provider-mask.ts";
import type { JsonValue, StoredReviewCommand } from "../integrations/types.ts";
import {
  STOPPED_EARLY_REASONS,
  type StoppedEarly,
} from "../runner-api/contract.ts";
import type { JobStatus } from "../jobs/job-status.ts";
import type { Job, JobTriggerKind } from "../jobs/job-types.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import {
  describeCheckoutReason,
  describeErrorCode,
  type ReasonDescription,
} from "./error-copy.ts";
import { runDurationMs } from "./run-duration.ts";

/** The most characters of a log the detail page shows (the runner's own limit). */
export const MAX_LOG_CHARS = 8192;

export type RunRowView = {
  id: string;
  repositoryId: string;
  /** The `owner/name` of the repository (a text from GitHub, rendered as text). */
  project: string;
  prNumber: number;
  /** The link to the pull request when it is an `https://github.com/` address, otherwise null. */
  prUrl: string | null;
  command: StoredReviewCommand;
  /** The review kind the run was queued for (#200): Diff Review or Dynamic Review. */
  reviewKind: ProjectReviewKind;
  triggerKind: JobTriggerKind;
  /** "Automatic", "Comment by octocat" or "Started by octocat". */
  trigger: string;
  status: JobStatus;
  createdAt: string;
  /** When a runner took the run; null while it waits (and for a run that never started). */
  startedAt: string | null;
  finishedAt: string | null;
  /** From start to end, or to the time of this answer for a running run; null when it has not started. */
  durationMs: number | null;
  /** One sentence for a run that did not succeed, or null. */
  problem: string | null;
};

/**
 * What a run consumed, as far as the runner reported it: only these four numbers and the model name
 * leave the server, never the rest of the stored `usage` (prompt and completion split, fallback flag).
 */
export type RunUsageView = {
  /** The model that answered, or null when the runner could not name it. A text from outside. */
  model: string | null;
  /** All tokens the run's calls used, summed. */
  totalTokens: number;
  /** How many model calls the run made. */
  aiCalls: number;
  /** The cost in US dollars; null when it is not known (a Dynamic Review never guesses it). */
  costUsd: number | null;
  /** Why a Dynamic Review was wrapped up early and may be incomplete (#293); null otherwise. */
  stoppedEarly: StoppedEarly | null;
};

export type RunDetailView = RunRowView & {
  headSha: string;
  /** The question of an `/ask`, or an empty string. Untrusted text. */
  args: string;
  /** Attempts lost to a lapsed lease or a given back claim. */
  attempts: number;
  errorCode: string | null;
  /** Whether the error code has a sentence of its own (an unknown one is shown with the general text). */
  errorCodeKnown: boolean;
  /** Why a Dynamic Review checkout failed, in words; null when the run has no reason (or none that is shaped like one). */
  errorReason: ReasonDescription | null;
  /** Only an `https://github.com/` address; null when the run has no comment or the address is not one. */
  commentUrl: string | null;
  /** The run succeeded but the runner could not find the comment it wrote. */
  commentMissing: boolean;
  log: { text: string; truncated: boolean };
  /** The newer run that replaced this one, for a replaced run. */
  supersededBy: string | null;
  /** The usage the runner reported, or null (a run that never reached a model, or an older result). */
  usage: RunUsageView | null;
  /**
   * The run was on a managed quality level (#283): its cost is not shown (`usage.costUsd` is null). With the tokens it
   * would give a price per token, which tells the model; the operator reads the cost through the operator API.
   */
  costHidden: boolean;
};

/** What the list can be narrowed by: one repository, one status. */
export type RunsFilter = { repositoryId?: string; status?: JobStatus };

export type RunsSnapshot = {
  /** When the answer was made; the duration of a running run is counted up to it. */
  generatedAt: string;
  runs: RunRowView[];
  /** More runs exist than are listed. */
  limited: boolean;
};

export type RunDetailSnapshot = { generatedAt: string; run: RunDetailView };

/**
 * A link to GitHub, only when it points to github.com over https (no other host, no credentials, no
 * port). Anything else, including a `javascript:` address, is no link: the comment of a run is written
 * by the runner and the pull request address comes with a delivery, and neither may take a person
 * anywhere else. Used for both links of a run.
 */
export function safeGithubUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048)
    return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const ok =
    parsed.protocol === "https:" &&
    parsed.hostname === "github.com" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "";
  return ok ? parsed.href : null;
}

// Escape sequences of a terminal: colors and cursor moves (CSI), and window titles or links (OSC).
const ANSI_SEQUENCES =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// Control characters other than tab and line feed, and the characters that reorder text on screen.
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Makes a runner's log fit for showing: terminal escapes and control characters out, line breaks
 * unified. The result is still only ever rendered as text.
 */
export function cleanLog(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_SEQUENCES, "")
    .replace(UNSAFE_CHARACTERS, "");
}

type StoredResult = {
  commentUrl: string | null;
  logTail: string;
  logTruncated: boolean;
  errorReason: string | null;
};

/** Reads the four fields the pages use from the stored result; everything else stays on the server. */
export function readStoredResult(result: JsonValue | null): StoredResult {
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return {
      commentUrl: null,
      logTail: "",
      logTruncated: false,
      errorReason: null,
    };
  return {
    commentUrl:
      typeof result.commentUrl === "string" ? result.commentUrl : null,
    logTail: typeof result.logTail === "string" ? result.logTail : "",
    logTruncated: result.logTruncated === true,
    errorReason:
      typeof result.errorReason === "string" ? result.errorReason : null,
  };
}

/** The longest model name the runner API accepts (`RunnerUsage.model`). */
const MAX_MODEL_CHARS = 200;

/** The first `max` characters of `text`, never a half of a surrogate pair. */
function cutCharacters(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : characters.slice(0, max).join("");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The model, the summed tokens, the call count and the cost of a stored result, or null when the
 * result has no usage or a field of it is not what the runner API promises. Nothing else of the usage
 * is copied. The model name is cleaned like the log: it came from the runner.
 */
export function readStoredUsage(result: JsonValue | null): RunUsageView | null {
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return null;
  const usage = result.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage))
    return null;
  const { model, totalTokens, aiCalls, costUsd } = usage;
  if (!isCount(totalTokens) || !isCount(aiCalls)) return null;
  const costKnown =
    typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0;
  if (costUsd !== null && !costKnown) return null;
  return {
    model:
      typeof model === "string"
        ? cutCharacters(cleanLog(model), MAX_MODEL_CHARS)
        : null,
    totalTokens,
    aiCalls,
    costUsd: costKnown ? costUsd : null,
    stoppedEarly:
      typeof usage.stoppedEarly === "string" &&
      (STOPPED_EARLY_REASONS as readonly string[]).includes(usage.stoppedEarly)
        ? (usage.stoppedEarly as StoppedEarly)
        : null,
  };
}

/**
 * Failed runs whose review is on the pull request all the same: the runner shortened it to fit
 * GitHub's comment limit and reports it as a failure, with the link to the comment it posted.
 */
const POSTED_REVIEW_ERROR_CODES: readonly string[] = [
  "review_state_truncated",
  "review_text_truncated",
];

function describeTrigger(kind: JobTriggerKind, actor: string): string {
  switch (kind) {
    case "webhook":
      return "Automatic";
    case "comment":
      return `Comment by ${actor}`;
    case "manual":
      return `Started by ${actor}`;
  }
}

/** The fields of a job the list needs; the list is read without the result, the lease or the arguments. */
export type RunRowSource = Pick<
  Job,
  | "id"
  | "repositoryId"
  | "prNumber"
  | "prUrl"
  | "command"
  | "reviewKind"
  | "triggerKind"
  | "actorLogin"
  | "status"
  | "createdAt"
  | "claimedAt"
  | "finishedAt"
  | "errorCode"
>;

function problemOf(job: RunRowSource): string | null {
  if (job.status === "failed" || job.status === "cancelled") {
    return job.errorCode === null
      ? job.status === "failed"
        ? "The run failed without saying why."
        : null
      : describeErrorCode(job.errorCode).text;
  }
  return null;
}

export function toRunRowView(
  job: RunRowSource,
  project: string,
  now: Date,
): RunRowView {
  const startedAt = job.claimedAt;
  return {
    id: job.id,
    repositoryId: job.repositoryId,
    project,
    prNumber: job.prNumber,
    prUrl: safeGithubUrl(job.prUrl),
    command: job.command,
    reviewKind: job.reviewKind,
    triggerKind: job.triggerKind,
    trigger: describeTrigger(job.triggerKind, job.actorLogin),
    status: job.status,
    createdAt: job.createdAt,
    startedAt,
    finishedAt: job.finishedAt,
    durationMs: runDurationMs(
      { status: job.status, startedAt, finishedAt: job.finishedAt },
      now,
    ),
    problem: problemOf(job),
  };
}

export function toRunDetailView(
  job: Job,
  project: string,
  now: Date,
  /** Removes secrets from the log (the second line of defense after the runner and the result check). */
  redact: (text: string) => string = (text) => text,
  /** Whether the run was on the operator's key (its usage record says so): its cost is not shown. */
  onManagedKey = false,
): RunDetailView {
  const stored = readStoredResult(job.result);
  // A run on the operator's key never names its provider, also when it was stored before the result was masked on its way in.
  const redactedLog = redact(cleanLog(stored.logTail));
  const cleaned = onManagedKey ? maskProvidersInText(redactedLog) : redactedLog;
  const overlong = cleaned.length > MAX_LOG_CHARS;
  const hasPostedReview =
    job.status === "succeeded" ||
    (job.status === "failed" &&
      job.errorCode !== null &&
      POSTED_REVIEW_ERROR_CODES.includes(job.errorCode));
  const commentUrl = hasPostedReview ? safeGithubUrl(stored.commentUrl) : null;
  const error =
    job.errorCode === null ? null : describeErrorCode(job.errorCode);
  return {
    ...toRunRowView(job, project, now),
    headSha: job.headSha,
    args: cleanLog(job.args),
    attempts: job.attempts,
    errorCode: error?.code ?? null,
    errorCodeKnown: error?.known ?? false,
    errorReason:
      job.status === "failed" && stored.errorReason !== null
        ? describeCheckoutReason(stored.errorReason)
        : null,
    commentUrl,
    commentMissing: job.status === "succeeded" && commentUrl === null,
    log: {
      text: overlong ? cleaned.slice(cleaned.length - MAX_LOG_CHARS) : cleaned,
      truncated: stored.logTruncated || overlong,
    },
    supersededBy: job.supersededBy,
    usage: usageView(job, redact, onManagedKey),
    costHidden: onManagedKey,
  };
}

function usageView(
  job: Job,
  redact: (text: string) => string,
  onManagedKey: boolean,
): RunUsageView | null {
  const stored = readStoredUsage(job.result);
  const usage =
    stored !== null && onManagedKey ? { ...stored, costUsd: null } : stored;
  if (usage === null || usage.model === null) return usage;
  // Redaction can lengthen the name: cut again, after it.
  return {
    ...usage,
    model: cutCharacters(redact(usage.model), MAX_MODEL_CHARS),
  };
}
