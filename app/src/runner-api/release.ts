// SPDX-License-Identifier: Apache-2.0

// POST /api/runners/v1/jobs/:id/release: a Dispatcher gives a claimed job back because it could not
// start the Worker (#322). It proves the dispatcher credential in `Authorization` (checked by the
// caller) and the claim with the per-job credential in the body: the hash of the credential is the lease
// token the queue fences on, so another job's credential, an earlier claim's and a made-up one all
// fail the same way. The job goes back through the queue's `release`: one attempt is counted (a failed
// launch has no budget of its own), the job waits again from `retryAfterSeconds`, or fails with the
// reason on the last allowed attempt.
import "server-only";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import { workerLeaseToken } from "../jobs/worker-credential.ts";
import { RUNNER_API_VERSION, type ReleaseResponse } from "./contract.ts";
import type { RunnerApiLogger } from "./logger.ts";
import { parseReleaseRequest } from "./requests.ts";
import {
  errorResponse,
  jsonResponse,
  workerUnauthorized,
} from "./responses.ts";

export type ReleaseDeps = {
  queue: Pick<RunnerQueue, "get" | "holding" | "release">;
  logger: RunnerApiLogger;
  now: () => Date;
};

/** The reason a job fails with when a Dispatcher gives it back; a reason the app does not know becomes this one. */
export const LAUNCH_FAILED_CODE = "launch_failed";

export async function handleRelease(
  deps: ReleaseDeps,
  jobId: string,
  runnerId: string,
  body: unknown,
): Promise<Response> {
  const parsed = parseReleaseRequest(body);
  if (!parsed.ok)
    return errorResponse(400, "RUNNER_REQUEST_INVALID", {
      fields: parsed.fields,
    });
  if ((await deps.queue.get(jobId)) === undefined)
    return errorResponse(404, "RUNNER_JOB_NOT_FOUND");

  const { credential, retryAfterSeconds } = parsed.value;
  const leaseToken = workerLeaseToken(credential);
  // The error code is stored on a job that fails, and the UI has copy for the codes it knows: the one
  // reason a Dispatcher has is a Worker that did not start.
  const released = await deps.queue.release(
    jobId,
    leaseToken,
    LAUNCH_FAILED_CODE,
    retryAfterSeconds === undefined
      ? undefined
      : { retryAt: new Date(deps.now().getTime() + retryAfterSeconds * 1000) },
  );
  if (released.status === "not_holder") {
    // A credential that is not the claim's is 401; the claim of that credential having ended is 409.
    const held = await deps.queue.holding(jobId, leaseToken);
    deps.logger.info(
      `[runner-api] release runner=${runnerId} job=${jobId} refused: ${held === undefined ? "credential" : "ended"}`,
    );
    return held === undefined
      ? workerUnauthorized()
      : errorResponse(409, "RUNNER_JOB_ENDED");
  }
  if (released.status === "cancelled")
    return errorResponse(409, "RUNNER_JOB_ENDED");
  deps.logger.info(
    `[runner-api] release runner=${runnerId} job=${jobId} reason=${parsed.value.reason} (${released.status})`,
  );
  return jsonResponse(200, {
    version: RUNNER_API_VERSION,
    job: {
      id: released.job.id,
      status: released.status === "requeued" ? "queued" : "failed",
    },
  } satisfies ReleaseResponse);
}
