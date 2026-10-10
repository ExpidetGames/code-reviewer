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
import { JobQueueError } from "./errors.ts";
import { validateEnqueueInput } from "./job-input.ts";
import type {
  ClaimResult,
  CompleteResult,
  EnqueueJobInput,
  EnqueueResult,
  HeartbeatResult,
  Job,
  JobOutcome,
} from "./job-types.ts";

export type JobQueue = {
  /**
   * Creates a job, or returns the one that makes a new job unnecessary.
   *
   * - The same delivery id enqueued twice gives the first job back (`same_delivery`).
   * - Automatic (`webhook`) jobs: one per repository, pull request, head commit and command, as long
   *   as that job is waiting, running or finished (`same_head`). A new automatic job replaces the
   *   waiting jobs of the same pull request and command (they become `superseded`); a running job
   *   keeps running.
   * - Jobs a person started (`comment`, `manual`) are exempt from the head commit rule, but never
   *   duplicate a waiting or running job for the same pull request, command and arguments
   *   (`already_active`).
   *
   * Rejects with a `JobQueueError` (`JOB_INPUT_INVALID`, with `fieldErrors`) and writes nothing when
   * the input is not valid.
   */
  enqueue(input: EnqueueJobInput): Promise<EnqueueResult>;
  /**
   * Gives the runner the oldest due job, or null. First puts jobs whose lease ran out back in the
   * queue (or fails them after the last attempt, or on timeout), so nothing else has to watch the
   * clock. At most one job per pull request is running at any time.
   */
  claimNext(runnerId: string): Promise<ClaimResult>;
  /** Extends the lease of a job this runner holds; `not_holder` if it does not hold it. */
  heartbeat(jobId: string, runnerId: string): Promise<HeartbeatResult>;
  /** Finishes a job this runner holds; reporting the same outcome again answers `already_completed`. */
  complete(
    jobId: string,
    runnerId: string,
    outcome: JobOutcome,
  ): Promise<CompleteResult>;
  /** The expiry step of `claimNext` on its own. */
  expireStaleJobs(): Promise<ExpiryReport>;
  /** Cancels all waiting jobs of a repository (project deactivated); running jobs finish. */
  cancelWaitingForRepository(repositoryId: string): Promise<number>;
  /** Cancels the waiting jobs of a pull request (it was closed); a running job finishes. */
  discardWaitingForPr(repositoryId: string, prNumber: number): Promise<number>;
  get(id: string): Promise<Job | undefined>;
  list(filter?: JobListFilter): Promise<Job[]>;
};

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
      return jobs.enqueue(checked.value);
    },
    claimNext: (runnerId) => jobs.claimNext(runnerId),
    heartbeat: (jobId, runnerId) => jobs.heartbeat(jobId, runnerId),
    complete: (jobId, runnerId, outcome) =>
      jobs.complete(jobId, runnerId, outcome),
    expireStaleJobs: () => jobs.expireStaleJobs(),
    cancelWaitingForRepository: (repositoryId) =>
      jobs.cancelWaitingForRepository(repositoryId),
    discardWaitingForPr: (repositoryId, prNumber) =>
      jobs.discardWaitingForPr(repositoryId, prNumber),
    get: (id) => jobs.get(id),
    list: (filter) => jobs.list(filter),
  };
}
