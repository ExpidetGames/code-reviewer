// POST /api/runners/v1/jobs/:id/heartbeat and /complete: what a runner says about a job it holds.
// Both prove the claim with the lease token of the claim response (not with the runner id, which is
// bookkeeping only), so a stale execution of a job that was requeued and claimed again gets 409
// even under the same runner id.
//
// The answers never contain the git token or the LLM key: only the claim response does.
import "server-only";
import type { JobQueue } from "../jobs/job-queue.ts";
import type { JobOutcome } from "../jobs/job-types.ts";
import {
  RUNNER_API_VERSION,
  RUNNER_ERROR_CODES,
  type CompleteResponse,
  type HeartbeatResponse,
} from "./contract.ts";
import type { ClaimedKeys } from "./claimed-keys.ts";
import { redactResult } from "./redact.ts";
import type { RunnerApiLogger } from "./logger.ts";
import {
  parseCompleteRequest,
  parseHeartbeatRequest,
  type Parsed,
} from "./requests.ts";
import { errorResponse, jsonResponse } from "./responses.ts";

export type ReportDeps = {
  queue: Pick<JobQueue, "get" | "heartbeat" | "complete" | "release">;
  logger: RunnerApiLogger;
  /** Exact values (the current LLM key, the runner token) that must never end up in a stored result. */
  knownSecrets: () => readonly string[];
  /** The LLM key each job was handed with its claim; it may differ from the current one. */
  claimedKeys: Pick<ClaimedKeys, "keysOf">;
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

  if ((await deps.queue.get(jobId)) === undefined)
    return errorResponse(404, "RUNNER_JOB_NOT_FOUND");

  // What is stored: the checked result with everything that looks like a credential removed. The
  // same report always gives the same stored value, which is what makes a repetition recognisable.
  // The key of the claim and the current one: the key may have been rotated while the job ran.
  const stored = redactResult(parsed.value.result, [
    ...deps.knownSecrets(),
    ...deps.claimedKeys.keysOf(jobId),
  ]);
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
  if (stored.errorCode === RUNNER_SHUTDOWN_CODE) {
    const released = await deps.queue.release(
      jobId,
      parsed.value.leaseToken,
      RUNNER_SHUTDOWN_CODE,
    );
    if (released.status === "not_holder") {
      deps.logger.info(
        `[runner-api] complete runner=${runnerId} job=${jobId} refused: lease lost`,
      );
      return errorResponse(409, "RUNNER_LEASE_LOST");
    }
    deps.logger.info(
      `[runner-api] complete runner=${runnerId} job=${jobId} given back: runner_shutdown (${released.status})`,
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

  const result = await deps.queue.complete(
    jobId,
    parsed.value.leaseToken,
    outcome,
  );
  switch (result.status) {
    case "not_holder":
      deps.logger.info(
        `[runner-api] complete runner=${runnerId} job=${jobId} refused: lease lost`,
      );
      return errorResponse(409, "RUNNER_LEASE_LOST");
    case "outcome_conflict":
      deps.logger.info(
        `[runner-api] complete runner=${runnerId} job=${jobId} refused: another result was stored before`,
      );
      return errorResponse(409, "RUNNER_RESULT_CONFLICT");
    case "completed":
    case "already_completed": {
      const status = result.job.status;
      if (status !== "succeeded" && status !== "failed")
        throw new Error(`Completed job ${jobId} has the status ${status}.`);
      deps.logger.info(
        `[runner-api] complete runner=${runnerId} job=${jobId} status=${status}${result.status === "already_completed" ? " (repeated)" : ""}`,
      );
      return jsonResponse(200, {
        version: RUNNER_API_VERSION,
        job: { id: result.job.id, status },
        alreadyCompleted: result.status === "already_completed",
      } satisfies CompleteResponse);
    }
  }
}
