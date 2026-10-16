// SPDX-License-Identifier: Apache-2.0

// POST /api/runners/v1/jobs/:id/heartbeat and /complete: what a runner says about a job it holds.
// Both prove the claim with the lease token of the claim response (not with the runner id, which is
// bookkeeping only), so a stale execution of a job that was requeued and claimed again gets 409
// even under the same runner id.
//
// The answers never contain the git token or the LLM key: only the claim response does.
import "server-only";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type { Job, JobOutcome } from "../jobs/job-types.ts";
import {
  RUNNER_API_VERSION,
  RUNNER_ERROR_CODES,
  type CompleteResponse,
  type HeartbeatResponse,
  type RunnerResult,
} from "./contract.ts";
import type { ClaimedKeys } from "./claimed-keys.ts";
import { maskModelInText } from "../llm/access.ts";
import { redactResult } from "./redact.ts";
import type { RunnerApiLogger } from "./logger.ts";
import {
  parseCompleteRequest,
  parseHeartbeatRequest,
  type Parsed,
} from "./requests.ts";
import { errorResponse, jsonResponse } from "./responses.ts";

export type ReportDeps = {
  queue: Pick<RunnerQueue, "get" | "heartbeat" | "complete" | "release">;
  logger: RunnerApiLogger;
  /**
   * Exact values that must never end up in a stored result: the runner token and the CURRENT LLM key of
   * the workspace the job belongs to (and the legacy variable, where it applies). Best effort; a lookup that
   * fails gives an empty list rather than failing the completion.
   */
  knownSecrets: (workspaceId: string) => Promise<readonly string[]>;
  /**
   * The LLM key each job was handed with its claim, which may differ from the current one, and the model of a managed
   * tier it was handed (#280). Read from the database.
   */
  claimedKeys: Pick<ClaimedKeys, "keysOf" | "modelsOf">;
  /**
   * Whether the job ran on a managed tier (its usage record names one), and every model id the operator has
   * configured for the tiers right now (#280). The remembered model of the job is not enough: its row may be
   * unreadable, and the runner may spell the model differently.
   */
  tierModels: (
    job: Job,
  ) => Promise<{ managed: boolean; models: readonly string[] }>;
};

/**
 * The code a runner reports when it is shut down while it holds a job (CR-29). The job did not fail
 * for its own reasons, so it is given back to the queue instead of being finished.
 */
export const RUNNER_SHUTDOWN_CODE = "runner_shutdown";

/** The code a failed job is stored with: a code the runner is known to use, or `unknown`. */
export function mapRunnerErrorCode(code: string): string {
  return RUNNER_ERROR_CODES.some((known) => known === code) ? code : "unknown";
}

/**
 * The result without the model of a managed tier (#280): `usage.model` is not reported (null) whatever the runner calls
 * the model, and the ids become `[model]` in the text fields at any length (the generic rule that follows ignores
 * secrets shorter than a credential could be). `hide` is whether the job ran on a tier.
 */
function withoutTierModel(
  result: RunnerResult,
  models: readonly string[],
  hide: boolean,
): RunnerResult {
  if (!hide) return result;
  const mask = (text: string) => maskModelInText(text, ...models);
  return {
    ...result,
    logTail: mask(result.logTail),
    errorMessage:
      result.errorMessage === null ? null : mask(result.errorMessage),
    commentUrl: result.commentUrl === null ? null : mask(result.commentUrl),
    usage: result.usage === null ? null : { ...result.usage, model: null },
  };
}

function invalid(parsed: Extract<Parsed<unknown>, { ok: false }>): Response {
  return errorResponse(400, "RUNNER_REQUEST_INVALID", {
    fields: parsed.fields,
  });
}

export async function handleHeartbeat(
  deps: ReportDeps,
  jobId: string,
  runnerId: string,
  body: unknown,
): Promise<Response> {
  const parsed = parseHeartbeatRequest(body);
  if (!parsed.ok) return invalid(parsed);

  if ((await deps.queue.get(jobId)) === undefined)
    return errorResponse(404, "RUNNER_JOB_NOT_FOUND");

  const result = await deps.queue.heartbeat(jobId, parsed.value.leaseToken);
  if (result.status === "not_holder") {
    deps.logger.info(
      `[runner-api] heartbeat runner=${runnerId} job=${jobId} refused: lease lost`,
    );
    return errorResponse(409, "RUNNER_LEASE_LOST");
  }
  const { job } = result;
  if (job.heartbeatAt === null || job.leaseExpiresAt === null)
    throw new Error(`Heartbeat of job ${jobId} left no times.`);
  return jsonResponse(200, {
    version: RUNNER_API_VERSION,
    job: {
      id: job.id,
      heartbeatAt: job.heartbeatAt,
      leaseExpiresAt: job.leaseExpiresAt,
    },
  } satisfies HeartbeatResponse);
}

export async function handleComplete(
  deps: ReportDeps,
  jobId: string,
  runnerId: string,
  body: unknown,
): Promise<Response> {
  const parsed = parseCompleteRequest(body);
  if (!parsed.ok) return invalid(parsed);

  const job = await deps.queue.get(jobId);
  if (job === undefined) return errorResponse(404, "RUNNER_JOB_NOT_FOUND");

  return finishJob(deps, {
    job,
    leaseToken: parsed.value.leaseToken,
    result: parsed.value.result,
    who: `runner=${runnerId}`,
    releaseCodes: [RUNNER_SHUTDOWN_CODE],
    extraSecrets: [],
  });
}

/**
 * The rest of a completion, shared by the runner API's `complete` and the Worker API's `result` (#320):
 * redact, store, or give the job back. `who` names the caller in the log line (never a secret),
 * `releaseCodes` are the error codes that give the job back instead of storing the result (the runner
 * API knows `runner_shutdown`; the Worker API adds `launch_failed`), and `extraSecrets` are values the
 * caller itself holds (the Worker's own credential) that must not end up in the stored result either.
 */
export async function finishJob(
  deps: ReportDeps,
  {
    job,
    leaseToken,
    result: reported,
    who,
    releaseCodes,
    extraSecrets,
  }: {
    job: Job;
    leaseToken: string;
    result: RunnerResult;
    who: string;
    releaseCodes: readonly string[];
    extraSecrets: readonly string[];
  },
): Promise<Response> {
  const jobId = job.id;
  // What is stored: the checked result with everything that looks like a credential removed. The
  // same report always gives the same stored value, which is what makes a repetition recognisable.
  // The key of the claim and the current one: the key may have been rotated while the job ran, and the
  // claim may have been served by another app instance (the key of the claim is in the database).
  //
  // The model of a managed tier is operator data a workspace must never read (#280): the job may repeat it in its
  // log or its error, and reports it as `usage.model`, which a Runs page shows. The model the job was handed is
  // remembered with its keys, so it is taken out whichever app instance serves the completion and whatever the
  // operator changed since; the tokens and the cost of the usage stay.
  const remembered = await deps.claimedKeys.modelsOf(jobId);
  const tier = await deps.tierModels(job);
  const models = [...new Set([...remembered, ...tier.models])];
  const stored = redactResult(
    withoutTierModel(reported, models, tier.managed || remembered.length > 0),
    [
      ...(await deps.knownSecrets(job.workspaceId)),
      ...(await deps.claimedKeys.keysOf(jobId)),
      ...models,
      ...extraSecrets,
    ],
  );
  const outcome: JobOutcome =
    stored.errorCode === null
      ? { ok: true, result: stored }
      : {
          ok: false,
          errorCode: mapRunnerErrorCode(stored.errorCode),
          result: stored,
        };

  // A runner that is shut down gives the job back: it waits again (one attempt counted, the same cap
  // as a lapsed lease) instead of failing for good with every redeploy. The result is not stored.
  if (stored.errorCode !== null && releaseCodes.includes(stored.errorCode)) {
    const released = await deps.queue.release(
      jobId,
      leaseToken,
      stored.errorCode,
    );
    if (released.status === "not_holder") {
      deps.logger.info(
        `[runner-api] complete ${who} job=${jobId} refused: lease lost`,
      );
      return errorResponse(409, "RUNNER_LEASE_LOST");
    }
    deps.logger.info(
      `[runner-api] complete ${who} job=${jobId} given back: ${stored.errorCode} (${released.status})`,
    );
    return jsonResponse(200, {
      version: RUNNER_API_VERSION,
      job: {
        id: released.job.id,
        status: released.status === "requeued" ? "queued" : "failed",
      },
      alreadyCompleted: false,
    } satisfies CompleteResponse);
  }

  const result = await deps.queue.complete(jobId, leaseToken, outcome);
  switch (result.status) {
    case "not_holder":
      deps.logger.info(
        `[runner-api] complete ${who} job=${jobId} refused: lease lost`,
      );
      return errorResponse(409, "RUNNER_LEASE_LOST");
    case "outcome_conflict":
      deps.logger.info(
        `[runner-api] complete ${who} job=${jobId} refused: another result was stored before`,
      );
      return errorResponse(409, "RUNNER_RESULT_CONFLICT");
    case "completed":
    case "already_completed": {
      const status = result.job.status;
      if (status !== "succeeded" && status !== "failed")
        throw new Error(`Completed job ${jobId} has the status ${status}.`);
      deps.logger.info(
        `[runner-api] complete ${who} job=${jobId} status=${status}${result.status === "already_completed" ? " (repeated)" : ""}`,
      );
      return jsonResponse(200, {
        version: RUNNER_API_VERSION,
        job: { id: result.job.id, status },
        alreadyCompleted: result.status === "already_completed",
      } satisfies CompleteResponse);
    }
  }
}
