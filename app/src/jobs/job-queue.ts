// SPDX-License-Identifier: LicenseRef-Proprietary

// The job queue of ONE workspace: the door through which jobs are created, dropped and read. It
// checks input (job-input.ts) and leaves every query to the jobs repository, which holds the rules
// of the queue in transactions. Handing jobs to runners and finishing them is not scoped and lives in
// runner-queue.ts. See README.md in this folder for the rules.
import "server-only";
import type { Kysely } from "kysely";
import {
  createJobsRepository,
  type JobListFilter,
  type JobsRepositoryOptions,
} from "../db/repositories/jobs-repository.ts";
import type { Database } from "../db/schema.ts";
import type { WorkspaceId } from "../db/workspace-scope.ts";
import { errorCode } from "../db/errors.ts";
import { JobQueueError } from "./errors.ts";
import { validateEnqueueInput } from "./job-input.ts";
import type { EnqueueJobInput, EnqueueResult, Job } from "./job-types.ts";

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
   * (`JOB_REPOSITORY_UNKNOWN`), also when it belongs to another workspace.
   */
  enqueue(input: EnqueueJobInput): Promise<EnqueueResult>;
  /** Cancels all waiting jobs of a repository (project deactivated); running jobs finish. */
  cancelWaitingForRepository(repositoryId: string): Promise<number>;
  /**
   * Cancels all waiting jobs of a repository because the project's review kind changed (#195). The
   * #194 settings hook calls this in the settings transaction: waiting jobs are cancelled with
   * `review_kind_changed`, running jobs finish, and a rejecting call rolls the settings change back.
   */
  cancelWaitingForReviewKindChange(repositoryId: string): Promise<number>;
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

export type JobQueueOptions = JobsRepositoryOptions & {
  /**
   * #326: called with the result of every `enqueue` that returned, after its transaction committed. It
   * must not wait for anything slow: the app hands the work to `after()` (src/dispatch/shared.ts). A
   * hook that throws is ignored, so it can never fail or undo an enqueue. Not called when the enqueue
   * rejected.
   */
  onEnqueued?: (result: EnqueueResult) => void;
};

export function createJobQueue(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  options: JobQueueOptions = {},
): JobQueue {
  const jobs = createJobsRepository(db, workspaceId, options);

  return {
    async enqueue(input) {
      const checked = validateEnqueueInput(input);
      if (!checked.ok)
        throw new JobQueueError(
          "JOB_INPUT_INVALID",
          `The job is not valid: ${checked.fieldErrors.map((error) => `${error.field} (${error.code})`).join(", ")}.`,
          { fieldErrors: checked.fieldErrors },
        );
      let result: EnqueueResult;
      try {
        result = await jobs.enqueue(checked.value);
      } catch (error) {
        if (errorCode(error) === "SQLITE_CONSTRAINT_FOREIGNKEY")
          throw repositoryUnknown(checked.value.repositoryId, error);
        throw error;
      }
      try {
        options.onEnqueued?.(result);
      } catch {
        // The job is queued; what a hook does after that is its own business.
      }
      return result;
    },
    cancelWaitingForRepository: (repositoryId) =>
      jobs.cancelWaitingForRepository(repositoryId),
    cancelWaitingForReviewKindChange: (repositoryId) =>
      jobs.cancelWaitingForReviewKindChange(repositoryId),
    discardWaitingForPr: (repositoryId, prNumber) =>
      jobs.discardWaitingForPr(repositoryId, prNumber),
    discardWaitingAutomaticForPr: (repositoryId, prNumber) =>
      jobs.discardWaitingAutomaticForPr(repositoryId, prNumber),
    get: (id) => jobs.get(id),
    list: (filter) => jobs.list(filter),
  };
}
