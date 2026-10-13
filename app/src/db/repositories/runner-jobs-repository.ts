// SPDX-License-Identifier: Apache-2.0

// The lease side of the job queue: handing jobs to runners, keeping their leases alive, finishing
// and giving them back, and expiring what ran out. INSTANCE LEVEL, on purpose: runners serve the whole
// instance with one shared token, so a claim hands out the oldest due job of ANY workspace. Every
// statement that changes a claimed job is keyed on the job id and the lease token of the claim (the
// token is the fence), and what comes back is a `Job` with its `workspaceId`, so everything the caller
// does next goes through repositories created for that workspace. Creating, dropping and reading jobs
// is scoped and lives in jobs-repository.ts.
//
// Every public operation that reads before it writes runs in one transaction. Transactions on this
// database take the write lock up front (`begin immediate`, see `dialect.ts`), so the check "is there
// a job already?" and the update that follows it cannot be separated by another writer.
import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { ExpressionBuilder, Kysely } from "kysely";
import {
  DEFAULT_JOB_QUEUE_LIMITS,
  type JobQueueLimits,
} from "../../jobs/job-limits.ts";
import {
  DEFAULT_ENGINES,
  reviewKindsForEngines,
  type RunnerEngine,
} from "../../jobs/runner-capabilities.ts";
import type { JobStatus } from "../../jobs/job-status.ts";
import type {
  CancelClaimedResult,
  ClaimResult,
  CompleteResult,
  HeartbeatResult,
  Job,
  JobErrorCode,
  JobOutcome,
  ReleaseResult,
} from "../../jobs/job-types.ts";
import { encodeJson, formatTimestamp } from "../codecs.ts";
import { databaseDriver, type DatabaseDriver } from "../driver.ts";
import type { Database } from "../schema.ts";
import { claimOldestDueJob, claimOldestDueJobPostgres } from "./jobs-claim.ts";
import { toJob } from "./jobs-repository.ts";

/** What `expireStaleJobs` did. */
export type ExpiryReport = {
  /** Running jobs whose lease ran out and that were put back in the queue. */
  requeued: number;
  /** Running jobs whose lease ran out on the last allowed attempt. */
  leaseExpired: number;
  /** Running jobs that ran longer than the hard limit. */
  timedOut: number;
  /** Waiting Dynamic jobs no capable runner claimed within the deadline (#195). */
  noCapableRunner: number;
};

export type RunnerJobsRepositoryOptions = {
  now?: () => Date;
  /** The random lease token of a claim. */
  newToken?: () => string;
  limits?: Partial<JobQueueLimits>;
  /** Overrides the engine read from the connection; tests only. */
  driver?: DatabaseDriver;
};

export type RunnerJobsRepository = {
  /**
   * Expires stale leases and runtimes, then hands the oldest due job the runner's engines can run to
   * the runner (or null). `engines` defaults to `pr-agent` for a previous-release caller that sends
   * no capability list. The result carries the lease token the runner must present from then on.
   */
  claimNext(
    runnerId: string,
    engines?: readonly RunnerEngine[],
  ): Promise<ClaimResult>;
  /**
   * Extends the lease of the claim `leaseToken` belongs to. A job past the hard limit is failed with
   * `timeout` by this call and answers `not_holder`.
   */
  heartbeat(jobId: string, leaseToken: string): Promise<HeartbeatResult>;
  /** Finishes the claim `leaseToken` belongs to. Reporting the same outcome again is not an error. */
  complete(
    jobId: string,
    leaseToken: string,
    outcome: JobOutcome,
  ): Promise<CompleteResult>;
  /**
   * Gives a claimed job back. It counts as a lost attempt, exactly like a lapsed lease: the job is
   * waiting again (at `retryAt`, default now), or failed with `reason` if it was the last allowed
   * attempt.
   */
  release(
    jobId: string,
    leaseToken: string,
    reason: string,
    options?: { retryAt?: Date },
  ): Promise<ReleaseResult>;
  /**
   * A job by its id, whatever its workspace: the runner API answers "no such job" before it looks at
   * a lease token.
   */
  get(id: string): Promise<Job | undefined>;
  /** Deals with leases and runtimes that ran out. `claimNext` does this first on every call. */
  expireStaleJobs(): Promise<ExpiryReport>;
  /**
   * Cancels one claimed job with `errorCode`, in one statement keyed on the job id and the lease token
   * of the claim (running -> cancelled). The attempt count is not touched and the job is never queued
   * in between. `not_holder` when the caller does not hold the job (any more).
   */
  cancelClaimed(
    jobId: string,
    leaseToken: string,
    errorCode: JobErrorCode,
  ): Promise<CancelClaimedResult>;
};

/** Which running jobs an attempt-losing statement applies to. */
type RunningScope = {
  /** Only jobs whose lease ran out at or before this timestamp. */
  leaseExpiredBefore?: string;
  /** Only this job, and only while `leaseToken` is its current claim. */
  claim?: { jobId: string; leaseToken: string };
};

function runningWhere(scope: RunningScope) {
  return (eb: ExpressionBuilder<Database, "jobs">) =>
    eb.and([
      eb("status", "=", "running"),
      ...(scope.leaseExpiredBefore === undefined
        ? []
        : [eb("lease_expires_at", "<=", scope.leaseExpiredBefore)]),
      ...(scope.claim === undefined
        ? []
        : [
            eb("id", "=", scope.claim.jobId),
            eb("lease_token", "=", scope.claim.leaseToken),
          ]),
    ]);
}

export function createRunnerJobsRepository(
  db: Kysely<Database>,
  options: RunnerJobsRepositoryOptions = {},
): RunnerJobsRepository {
  const now = options.now ?? (() => new Date());
  const newToken = options.newToken ?? (() => crypto.randomUUID());
  const limits = { ...DEFAULT_JOB_QUEUE_LIMITS, ...options.limits };
  const driver = options.driver ?? databaseDriver(db);

  // A transaction cannot start another one; inside one, just use it.
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  }

  /**
   * One attempt of a running job is lost (its lease ran out, or its holder gave it back). This is the
   * single rule for that: on the last allowed attempt the job fails with `errorCode`, otherwise it
   * goes back to the queue and its holder is dropped. Runner and claim time stay on a failed job (and
   * so does the lease token), so a late report from the old holder is recognised and refused.
   */
  async function loseAttempt(
    executor: Kysely<Database>,
    scope: RunningScope,
    errorCode: string,
    timestamp: string,
    runAfter?: string,
  ): Promise<{ failed: number; requeued: number }> {
    const failed = await executor
      .updateTable("jobs")
      .set((eb) => ({
        status: "failed",
        attempts: eb("attempts", "+", 1),
        error_code: errorCode,
        lease_expires_at: null,
        finished_at: timestamp,
        updated_at: timestamp,
      }))
      .where(runningWhere(scope))
      .where("attempts", ">=", limits.maxAttempts - 1)
      .executeTakeFirst();

    const requeued = await executor
      .updateTable("jobs")
      .set((eb) => ({
        status: "queued",
        attempts: eb("attempts", "+", 1),
        runner_id: null,
        lease_token: null,
        claimed_at: null,
        heartbeat_at: null,
        lease_expires_at: null,
        ...(runAfter === undefined ? {} : { run_after: runAfter }),
        updated_at: timestamp,
      }))
      .where(runningWhere(scope))
      .executeTakeFirst();

    return {
      failed: Number(failed.numUpdatedRows),
      requeued: Number(requeued.numUpdatedRows),
    };
  }

  /**
   * Cancels every removed command (#203) that is still waiting or whose running lease ran out. Such
   * a row can never be executed again, so it must not occupy its pull request or be requeued. The
   * job keeps its id, command, args, actor, attempts and results; only the status, the error code
   * and the timestamps change.
   */
  async function cancelRemovedCommands(
    executor: Kysely<Database>,
    timestamp: string,
  ): Promise<number> {
    const waiting = await executor
      .updateTable("jobs")
      .set({
        status: "cancelled",
        error_code: "command_removed" satisfies JobErrorCode,
        runner_id: null,
        lease_token: null,
        claimed_at: null,
        heartbeat_at: null,
        lease_expires_at: null,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where("status", "=", "queued")
      .where("command", "!=", "review")
      .executeTakeFirst();
    const expired = await executor
      .updateTable("jobs")
      .set({
        status: "cancelled",
        error_code: "command_removed" satisfies JobErrorCode,
        lease_expires_at: null,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where("status", "=", "running")
      .where("command", "!=", "review")
      .where("lease_expires_at", "<=", timestamp)
      .executeTakeFirst();
    return Number(waiting.numUpdatedRows) + Number(expired.numUpdatedRows);
  }

  /** Fails running jobs that were claimed longer ago than the hard limit allows. */
  async function failTimedOut(
    executor: Kysely<Database>,
    scope: RunningScope,
    current: Date,
  ): Promise<number> {
    const timestamp = formatTimestamp(current);
    const startedBefore = formatTimestamp(
      new Date(current.getTime() - limits.maxRuntimeMs),
    );
    const result = await executor
      .updateTable("jobs")
      .set({
        status: "failed",
        error_code: "timeout" satisfies JobErrorCode,
        lease_expires_at: null,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where(runningWhere(scope))
      .where("claimed_at", "<=", startedBefore)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * #195 (finding 1): a Dynamic job no capable runner claims within the deadline would wait forever,
   * because eligibility excludes it and expiry only handles running jobs. It is cancelled (not failed
   * for a review reason), with the stable code `no_capable_runner`, without an attempt and without a
   * credential. The deadline is operator-owned (`noCapableRunnerMs`).
   */
  async function cancelStrandedDynamic(
    executor: Kysely<Database>,
    current: Date,
  ): Promise<number> {
    const timestamp = formatTimestamp(current);
    const strandedBefore = formatTimestamp(
      new Date(current.getTime() - limits.noCapableRunnerMs),
    );
    const result = await executor
      .updateTable("jobs")
      .set({
        status: "cancelled",
        error_code: "no_capable_runner" satisfies JobErrorCode,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where("status", "=", "queued")
      .where("review_kind", "=", "dynamic")
      // A claimed job follows the lease/attempt policy, never this initial capability deadline.
      .where("attempts", "=", 0)
      .where("created_at", "<=", strandedBefore)
      .where("run_after", "<=", strandedBefore)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async function expire(
    executor: Kysely<Database>,
    current: Date,
  ): Promise<ExpiryReport> {
    const timestamp = formatTimestamp(current);
    // Removed commands (#203) never run again. A waiting row may still appear after the data
    // migration (a race); a running one was claimed before the upgrade. They are cancelled here so
    // they can neither starve review jobs nor be requeued.
    await cancelRemovedCommands(executor, timestamp);
    // A Dynamic job no runner can run must not wait forever (#195).
    const noCapableRunner = await cancelStrandedDynamic(executor, current);
    const lost = await loseAttempt(
      executor,
      { leaseExpiredBefore: timestamp },
      "lease_expired" satisfies JobErrorCode,
      timestamp,
    );
    // A job whose runner keeps the lease alive but never finishes. Lost leases come first: a job
    // whose runner vanished long ago is retried, not failed for taking long.
    const timedOut = await failTimedOut(executor, {}, current);
    return {
      requeued: lost.requeued,
      leaseExpired: lost.failed,
      timedOut,
      noCapableRunner,
    };
  }

  return {
    claimNext(runnerId, engines = DEFAULT_ENGINES) {
      return inTransaction(async (trx) => {
        const current = now();
        await expire(trx, current);
        const leaseToken = newToken();
        const claim = {
          runnerId,
          leaseToken,
          now: current,
          leaseExpiresAt: new Date(current.getTime() + limits.leaseMs),
        };
        const reviewKinds = reviewKindsForEngines(engines);
        const row = await (
          driver === "postgres" ? claimOldestDueJobPostgres : claimOldestDueJob
        )(trx, claim, reviewKinds);
        return row === undefined ? null : { job: toJob(row), leaseToken };
      });
    },

    heartbeat(jobId, leaseToken) {
      return inTransaction<HeartbeatResult>(async (trx) => {
        const current = now();
        const timestamp = formatTimestamp(current);
        // The hard limit does not depend on anyone else's claim: the holder that is past it learns
        // so here, and the job fails.
        await failTimedOut(trx, { claim: { jobId, leaseToken } }, current);
        const row = await trx
          .updateTable("jobs")
          .set({
            heartbeat_at: timestamp,
            lease_expires_at: formatTimestamp(
              new Date(current.getTime() + limits.leaseMs),
            ),
            updated_at: timestamp,
          })
          .where(runningWhere({ claim: { jobId, leaseToken } }))
          .returningAll()
          .executeTakeFirst();
        return row === undefined
          ? { status: "not_holder" }
          : { status: "ok", job: toJob(row) };
      });
    },

    complete(jobId, leaseToken, outcome) {
      const target: JobStatus = outcome.ok ? "succeeded" : "failed";
      const errorCode = outcome.ok ? null : outcome.errorCode;
      const result = outcome.result ?? null;
      return inTransaction<CompleteResult>(async (trx) => {
        const timestamp = formatTimestamp(now());
        const finished = await trx
          .updateTable("jobs")
          .set({
            status: target,
            result: result === null ? null : encodeJson(result),
            error_code: errorCode,
            lease_expires_at: null,
            finished_at: timestamp,
            updated_at: timestamp,
          })
          .where(runningWhere({ claim: { jobId, leaseToken } }))
          .returningAll()
          .executeTakeFirst();
        if (finished !== undefined)
          return { status: "completed", job: toJob(finished) };

        // Not running any more: either this claim already reported (same or other outcome), or it
        // was lost, or it never existed.
        const row = await trx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", jobId)
          .where("lease_token", "=", leaseToken)
          .executeTakeFirst();
        if (row === undefined) return { status: "not_holder" };
        const job = toJob(row);
        if (job.status !== "succeeded" && job.status !== "failed")
          return { status: "not_holder" };
        const sameOutcome =
          job.status === target &&
          job.errorCode === errorCode &&
          isDeepStrictEqual(job.result, result);
        return sameOutcome
          ? { status: "already_completed", job }
          : { status: "outcome_conflict", job };
      });
    },

    release(jobId, leaseToken, reason, releaseOptions = {}) {
      return inTransaction<ReleaseResult>(async (trx) => {
        const timestamp = formatTimestamp(now());
        // A removed command (#203) that is given back is cancelled, never requeued: no attempt of it
        // may ever run again. Only the current holder (the lease token) may cancel it this way.
        const removed = await trx
          .updateTable("jobs")
          .set({
            status: "cancelled",
            error_code: "command_removed" satisfies JobErrorCode,
            lease_expires_at: null,
            finished_at: timestamp,
            updated_at: timestamp,
          })
          .where(runningWhere({ claim: { jobId, leaseToken } }))
          .where("command", "!=", "review")
          .returningAll()
          .executeTakeFirst();
        if (removed !== undefined)
          return { status: "cancelled", job: toJob(removed) };
        const lost = await loseAttempt(
          trx,
          { claim: { jobId, leaseToken } },
          reason,
          timestamp,
          releaseOptions.retryAt === undefined
            ? undefined
            : formatTimestamp(releaseOptions.retryAt),
        );
        if (lost.failed === 0 && lost.requeued === 0)
          return { status: "not_holder" };
        const row = await trx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", jobId)
          .executeTakeFirstOrThrow();
        return lost.failed > 0
          ? { status: "failed", job: toJob(row) }
          : { status: "requeued", job: toJob(row) };
      });
    },

    async get(id) {
      const row = await db
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toJob(row);
    },

    expireStaleJobs() {
      return inTransaction((trx) => expire(trx, now()));
    },

    async cancelClaimed(jobId, leaseToken, errorCode) {
      const timestamp = formatTimestamp(now());
      // Not a transition of the shared table (`canTransition`): `cancelWaiting` derives its statuses
      // from that table and a deactivation must never cancel running jobs. This one statement is the
      // only way a running job becomes cancelled, and only for the holder of the claim.
      const row = await db
        .updateTable("jobs")
        .set({
          status: "cancelled",
          error_code: errorCode,
          lease_expires_at: null,
          finished_at: timestamp,
          updated_at: timestamp,
        })
        .where(runningWhere({ claim: { jobId, leaseToken } }))
        .returningAll()
        .executeTakeFirst();
      return row === undefined
        ? { status: "not_holder" }
        : { status: "cancelled", job: toJob(row) };
    },
  };
}
