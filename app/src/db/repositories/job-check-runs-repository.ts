// SPDX-License-Identifier: Apache-2.0

// Access to where the check runs and review verdicts of the jobs of ONE workspace stand (the table `job_check_runs`;
// the factory takes the workspace id, see ../workspace-scope.ts): src/check-runs/README.md. One row per job. `take`
// is one statement, so of several callers (several app instances included) exactly one syncs a job at a time; the
// ids make a sync idempotent. A row that is settled or dropped never changes again; one that failed is taken again
// only after its back-off, and is dropped when its attempts are used up. A row of another workspace is simply not
// there.
import "server-only";
import type { Kysely, Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, JobCheckRunsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** Where the work of a job stands. `dropped`: nothing more will be done (no permission, retries used up). */
export const JOB_CHECK_STATES = ["active", "settled", "dropped"] as const;
export type JobCheckState = (typeof JOB_CHECK_STATES)[number];

/** Where the check run alone stands: `dropped` when the App may not write check runs (the verdict goes on). */
export const CHECK_RUN_STATES = ["active", "dropped"] as const;
export type CheckRunState = (typeof CHECK_RUN_STATES)[number];

/** Where the verdict stands: not decided yet, submitted or decided not to (`done`), or refused by the platform. */
export const REVIEW_VERDICT_STATES = ["pending", "done", "dropped"] as const;
export type ReviewVerdictState = (typeof REVIEW_VERDICT_STATES)[number];

/** A row as the rest of the app sees it. Timestamps are ISO 8601 text in UTC. */
export type StoredJobCheck = {
  jobId: string;
  workspaceId: string;
  checkRunId: string | null;
  reviewId: string | null;
  /** The job status the check run shows now (a `JobStatus`); null before the first sync. */
  syncedStatus: string | null;
  checkCreateAttempts: number;
  reviewSubmitAttempts: number;
  checkState: CheckRunState;
  reviewState: ReviewVerdictState;
  state: JobCheckState;
  attempts: number;
  nextAttemptAt: string;
  lastCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TakeResult =
  | {
      acquired: true;
      /** True when this call made the row: no earlier sync of the job ever started. */
      created: boolean;
      check: StoredJobCheck;
    }
  | { acquired: false };

export type JobCheckRunsRepository = {
  find(jobId: string): Promise<StoredJobCheck | undefined>;
  /**
   * Takes the job for one sync: makes its row, or takes an `active` one whose lease or back-off is over. For
   * `leaseMs` nobody else takes it. Every other case (settled, dropped, held, a job of another workspace) is
   * `acquired: false`. One statement.
   */
  take(jobId: string, options: { leaseMs: number }): Promise<TakeResult>;
  /** Counts the start of a call that makes something on the platform, BEFORE the call. */
  noteStarted(jobId: string, what: "check" | "review"): Promise<void>;
  /** The check run exists and shows this status of the job. */
  recordCheck(
    jobId: string,
    check: { checkRunId: string; syncedStatus: string },
  ): Promise<void>;
  /** No check run will be written for the job (the App lacks the permission); the verdict is not affected. */
  dropCheck(jobId: string, code: string): Promise<void>;
  /** The verdict is submitted (`reviewId`) or decided not to be (null), or the platform refused it (`dropped`). */
  recordReview(
    jobId: string,
    review: { reviewId: string | null; reviewState: "done" | "dropped" },
  ): Promise<void>;
  /** Ends the sync: the lease is over and the failures are forgotten. `settled`: the job ended and all is done. */
  finish(jobId: string, outcome: { settled: boolean }): Promise<void>;
  /** The sync failed: it waits until `retryAt`, and is dropped when `maxAttempts` failures are reached. */
  failed(
    jobId: string,
    failure: { code: string; retryAt: Date; maxAttempts: number },
  ): Promise<void>;
  /** Nothing more will be done for the job, whatever happens to it: `code` says why. */
  drop(jobId: string, code: string): Promise<void>;
};

export function toStoredJobCheck(
  row: Selectable<JobCheckRunsTable>,
): StoredJobCheck {
  return {
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    checkRunId: row.check_run_id,
    reviewId: row.review_id,
    syncedStatus: row.synced_status,
    checkCreateAttempts: row.check_create_attempts,
    reviewSubmitAttempts: row.review_submit_attempts,
    checkState: row.check_state as CheckRunState,
    reviewState: row.review_state as ReviewVerdictState,
    state: row.state as JobCheckState,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastCode: row.last_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createJobCheckRunsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): JobCheckRunsRepository {
  /** A change to an `active` row of this workspace's job; a settled or dropped row is left as it is. */
  const active = (jobId: string) =>
    db
      .updateTable("job_check_runs")
      .where("workspace_id", "=", workspaceId)
      .where("job_id", "=", jobId)
      .where("state", "=", "active");

  return {
    async find(jobId) {
      const row = await db
        .selectFrom("job_check_runs")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("job_id", "=", jobId)
        .executeTakeFirst();
      return row === undefined ? undefined : toStoredJobCheck(row);
    },

    async take(jobId, options) {
      // The row references the job without its workspace: the job must be one of this workspace.
      const own = await db
        .selectFrom("jobs")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", jobId)
        .executeTakeFirst();
      if (own === undefined) return { acquired: false };
      const current = now();
      const timestamp = formatTimestamp(current);
      const leaseEnds = formatTimestamp(
        new Date(current.getTime() + options.leaseMs),
      );
      const fresh = {
        job_id: jobId,
        workspace_id: workspaceId,
        check_run_id: null,
        review_id: null,
        synced_status: null,
        check_create_attempts: 0,
        review_submit_attempts: 0,
        check_state: "active",
        review_state: "pending",
        state: "active",
        attempts: 0,
        next_attempt_at: leaseEnds,
        last_code: null,
        created_at: timestamp,
        updated_at: timestamp,
      } as const;
      // First the row itself: of several callers exactly one makes it, and that one knows no earlier sync ever
      // started. Then, for an existing row, the guarded change of the lease, again won by exactly one.
      const made = await db
        .insertInto("job_check_runs")
        .values(fresh)
        .onConflict((conflict) => conflict.column("job_id").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (made !== undefined)
        return { acquired: true, created: true, check: toStoredJobCheck(made) };
      const taken = await db
        .updateTable("job_check_runs")
        .set({ next_attempt_at: leaseEnds, updated_at: timestamp })
        .where("workspace_id", "=", workspaceId)
        .where("job_id", "=", jobId)
        .where("state", "=", "active")
        .where("next_attempt_at", "<=", timestamp)
        .returningAll()
        .executeTakeFirst();
      return taken === undefined
        ? { acquired: false }
        : { acquired: true, created: false, check: toStoredJobCheck(taken) };
    },

    async noteStarted(jobId, what) {
      const column =
        what === "check" ? "check_create_attempts" : "review_submit_attempts";
      await active(jobId)
        .set((eb) => ({
          [column]: eb(column, "+", 1),
          updated_at: formatTimestamp(now()),
        }))
        .execute();
    },

    async recordCheck(jobId, check) {
      await active(jobId)
        .set({
          check_run_id: check.checkRunId,
          synced_status: check.syncedStatus,
          updated_at: formatTimestamp(now()),
        })
        .execute();
    },

    async dropCheck(jobId, code) {
      await active(jobId)
        .set({
          check_state: "dropped",
          last_code: code,
          updated_at: formatTimestamp(now()),
        })
        .execute();
    },

    async recordReview(jobId, review) {
      await active(jobId)
        .set({
          review_id: review.reviewId,
          review_state: review.reviewState,
          updated_at: formatTimestamp(now()),
        })
        .execute();
    },

    async finish(jobId, outcome) {
      const timestamp = formatTimestamp(now());
      await active(jobId)
        .set({
          state: outcome.settled ? "settled" : "active",
          attempts: 0,
          next_attempt_at: timestamp,
          updated_at: timestamp,
        })
        .execute();
    },

    async failed(jobId, failure) {
      const timestamp = formatTimestamp(now());
      await active(jobId)
        .set((eb) => ({
          attempts: eb("attempts", "+", 1),
          state: eb
            .case()
            .when(eb("attempts", "+", 1), ">=", failure.maxAttempts)
            .then("dropped")
            .else("active")
            .end(),
          next_attempt_at: formatTimestamp(failure.retryAt),
          last_code: failure.code,
          updated_at: timestamp,
        }))
        .execute();
    },

    async drop(jobId, code) {
      await active(jobId)
        .set({
          state: "dropped",
          last_code: code,
          updated_at: formatTimestamp(now()),
        })
        .execute();
    },
  };
}
