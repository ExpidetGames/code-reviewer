// SPDX-License-Identifier: Apache-2.0

// The runner side of the job queue: handing jobs to runners and finishing them. NOT scoped to a
// workspace, on purpose: runners serve the whole instance (one shared token), so a claim hands out the
// oldest due job of any workspace. What it returns carries `workspaceId`; everything the runner API
// looks up for the job afterwards goes through repositories of that workspace. Creating, dropping and
// listing jobs is scoped and lives in job-queue.ts.
import "server-only";
import type { Kysely } from "kysely";
import {
  createRunnerJobsRepository,
  type ExpiryReport,
  type RunnerJobsRepositoryOptions,
} from "../db/repositories/runner-jobs-repository.ts";
import type { Database } from "../db/schema.ts";
import { JobQueueError } from "./errors.ts";
import type { RunnerEngine } from "./runner-capabilities.ts";
import type {
  CancelClaimedResult,
  ClaimResult,
  CompleteResult,
  HeartbeatResult,
  Job,
  JobErrorCode,
  JobOutcome,
  ReleaseResult,
} from "./job-types.ts";

export type RunnerQueue = {
  /**
   * Gives the runner the oldest due job its engines can run, with the lease token of the claim, or
   * null. `engines` (#195) is what the runner advertised; a previous-release caller sends none and
   * is `pr-agent` only. An unsupported job is never selected: it waits, no attempt is counted and no
   * credential is created. First puts jobs whose lease ran out back in the queue (or fails them after
   * the last attempt, or on timeout), so nothing else has to watch the clock. At most one job per
   * pull request is running at any time.
   */
  claimNext(
    runnerId: string,
    engines?: readonly RunnerEngine[],
  ): Promise<ClaimResult>;
  /**
   * Extends the lease of the claim the token belongs to; `not_holder` for any other token (a stale
   * execution of the same job counts, even under the same runner id) and for a job past the hard
   * limit, which this call fails with `timeout`.
   */
  heartbeat(jobId: string, leaseToken: string): Promise<HeartbeatResult>;
  /** Finishes the claim; reporting the same outcome again answers `already_completed`. */
  complete(
    jobId: string,
    leaseToken: string,
    outcome: JobOutcome,
  ): Promise<CompleteResult>;
  /**
   * Gives a claimed job back (for example the runner shuts down, or the token for the repository
   * could not be created). It counts as a lost attempt with the same cap as a lapsed lease: the job
   * waits again, from `retryAt` if given, or fails with `reason` on the last allowed attempt.
   */
  release(
    jobId: string,
    leaseToken: string,
    reason: string,
    options?: { retryAt?: Date },
  ): Promise<ReleaseResult>;
  /**
   * Cancels a claimed job (the project of its repository is off): running -> cancelled with
   * `errorCode`, in one statement fenced by the lease token. No attempt is counted, so the job ends
   * `cancelled` also on its last allowed attempt, and it is never queued again in between.
   */
  cancelClaimed(
    jobId: string,
    leaseToken: string,
    errorCode: JobErrorCode,
  ): Promise<CancelClaimedResult>;
  /** A job by its id, whatever its workspace. */
  get(id: string): Promise<Job | undefined>;
  /** The expiry step of `claimNext` on its own. */
  expireStaleJobs(): Promise<ExpiryReport>;
};

export function createRunnerQueue(
  db: Kysely<Database>,
  options: RunnerJobsRepositoryOptions = {},
): RunnerQueue {
  const jobs = createRunnerJobsRepository(db, options);

  return {
    claimNext: (runnerId, engines) => jobs.claimNext(runnerId, engines),
    heartbeat: (jobId, leaseToken) => jobs.heartbeat(jobId, leaseToken),
    complete: (jobId, leaseToken, outcome) =>
      jobs.complete(jobId, leaseToken, outcome),
    async release(jobId, leaseToken, reason, releaseOptions) {
      if (reason.trim() === "")
        throw new JobQueueError(
          "JOB_INPUT_INVALID",
          "The reason is not valid: reason (required).",
          { fieldErrors: [{ field: "reason", code: "required" }] },
        );
      return jobs.release(jobId, leaseToken, reason, releaseOptions);
    },
    get: (id) => jobs.get(id),
    expireStaleJobs: () => jobs.expireStaleJobs(),
    cancelClaimed: (jobId, leaseToken, errorCode) =>
      jobs.cancelClaimed(jobId, leaseToken, errorCode),
  };
}
