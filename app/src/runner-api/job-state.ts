// SPDX-License-Identifier: Apache-2.0

// GET /api/runners/v1/jobs/:id: the status of a job, for a Dispatcher that reaps the VMs of jobs that ended (#364).
// Read only, and the answer is the status alone: no job input, lease, repository or credential. It proves the
// dispatcher credential only (checked by the caller); a per-job credential does not open it.
import "server-only";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import { RUNNER_API_VERSION, type JobStateResponse } from "./contract.ts";
import { errorResponse, jsonResponse } from "./responses.ts";

export type JobStateDeps = {
  queue: Pick<RunnerQueue, "get">;
};

export async function handleJobState(
  deps: JobStateDeps,
  jobId: string,
): Promise<Response> {
  const job = await deps.queue.get(jobId);
  if (job === undefined) return errorResponse(404, "RUNNER_JOB_NOT_FOUND");
  return jsonResponse(200, {
    version: RUNNER_API_VERSION,
    job: { id: job.id, status: job.status },
  } satisfies JobStateResponse);
}
