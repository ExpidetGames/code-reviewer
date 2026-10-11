// The job queue: the one door through which jobs are created, handed to runners and finished. It
// checks input (job-input.ts) and leaves every query to the jobs repository, which holds the rules
// of the queue in transactions. See README.md in this folder for the rules.
import "server-only";
import type { Kysely } from "kysely";
import {
  createJobsRepository,
  type ExpiryReport,
  type JobListFilter,
  type JobsRepositoryOptions,
} from "../db/repositories/jobs-repository.ts";
import type { Database } from "../db/schema.ts";
import { errorCode } from "../db/errors.ts";
import { JobQueueError } from "./errors.ts";
import { validateEnqueueInput } from "./job-input.ts";
import type {
  CancelClaimedResult,
  ClaimResult,
  CompleteResult,
  EnqueueJobInput,
  EnqueueResult,
  HeartbeatResult,
  Job,
  JobErrorCode,
  JobOutcome,
  ReleaseResult,
} from "./job-types.ts";

export type JobQueue = {
  /**
   * Creates a job, or returns the one that makes a new job unnecessary.
   *
   * - The same delivery id enqueued twice gives the first job back (`same_delivery`).
   * - The same comment (`commentId`) of a repository enqueued twice, under any delivery id, gives
   *   the job that answered it back (`same_comment`), whatever became of that job. A comment is
   *   recorded with the job that answers it, also when that job existed already (`already_active`).
   * - Automatic (`webhook`) jobs: one per repository, pull request, head commit and command, as long
   *   as that job is waiting, running or finished (`same_head`). A new automatic job replaces the
   *   waiting jobs of the same pull request and command (they become `superseded`); a running job
   *   keeps running.
   * - Jobs a person started (`comment`, `manual`) are exempt from the head commit rule, but never
   *   duplicate a waiting or running job for the same pull request, command and arguments
   *   (`already_active`: the existing job is returned, and a waiting one that was held back is made
   *   due now). They are never superseded.
   *
   * Rejects with a `JobQueueError` and writes nothing when the input is not valid
   * (`JOB_INPUT_INVALID`, with `fieldErrors`) or the repository does not exist
   * (`JOB_REPOSITORY_UNKNOWN`).
   */
  enqueue(input: EnqueueJobInput): Promise<EnqueueResult>;
  /**
   * Gives the runner the oldest due job with the lease token of the claim, or null. First puts jobs
   * whose lease ran out back in the queue (or fails them after the last attempt, or on timeout), so
   * nothing else has to watch the clock. At most one job per pull request is running at any time.
   */
  claimNext(runnerId: string): Promise<ClaimResult>;
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
  /** The expiry step of `claimNext` on its own. */
  expireStaleJobs(): Promise<ExpiryReport>;
  /** Cancels all waiting jobs of a repository (project deactivated); running jobs finish. */
  cancelWaitingForRepository(repositoryId: string): Promise<number>;
  /**
   * Cancels every waiting job of a pull request (it was closed): the automatic ones and the ones a
   * person started with a comment or the start button. A running job finishes.
   */
  discardWaitingForPr(repositoryId: string, prNumber: number): Promise<number>;
  /**
   * Cancels the waiting automatic jobs of a pull request (it was turned into a draft). Jobs a person
   * started stay: a draft can be reviewed on request. A running job finishes.
   */
  discardWaitingAutomaticForPr(
    repositoryId: string,
    prNumber: number,
  ): Promise<number>;
  get(id: string): Promise<Job | undefined>;
  list(filter?: JobListFilter): Promise<Job[]>;
};

function repositoryUnknown(repositoryId: string, cause: unknown) {
  return new JobQueueError(
    "JOB_REPOSITORY_UNKNOWN",
    `No repository row ${repositoryId}.`,
    { cause },
  );
}

export function createJobQueue(
  db: Kysely<Database>,
  options: JobsRepositoryOptions = {},
): JobQueue {
  const jobs = createJobsRepository(db, options);

  return {
    async enqueue(input) {
      const checked = validateEnqueueInput(input);
      if (!checked.ok)
        throw new JobQueueError(
          "JOB_INPUT_INVALID",
          `The job is not valid: ${checked.fieldErrors.map((error) => `${error.field} (${error.code})`).join(", ")}.`,
          { fieldErrors: checked.fieldErrors },
        );
      try {
        return await jobs.enqueue(checked.value);
      } catch (error) {
        if (errorCode(error) === "SQLITE_CONSTRAINT_FOREIGNKEY")
          throw repositoryUnknown(checked.value.repositoryId, error);
        throw error;
      }
    },
    claimNext: (runnerId) => jobs.claimNext(runnerId),
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
    expireStaleJobs: () => jobs.expireStaleJobs(),
    cancelClaimed: (jobId, leaseToken, errorCode) =>
      jobs.cancelClaimed(jobId, leaseToken, errorCode),
    cancelWaitingForRepository: (repositoryId) =>
      jobs.cancelWaitingForRepository(repositoryId),
    discardWaitingForPr: (repositoryId, prNumber) =>
      jobs.discardWaitingForPr(repositoryId, prNumber),
    discardWaitingAutomaticForPr: (repositoryId, prNumber) =>
      jobs.discardWaitingAutomaticForPr(repositoryId, prNumber),
    get: (id) => jobs.get(id),
    list: (filter) => jobs.list(filter),
  };
}
