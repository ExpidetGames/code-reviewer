// Access to the jobs table: every query and every write of the job queue. The only code that reads or
// writes it. The rules of the queue are described in `src/jobs/README.md`; this file is where they
// are enforced, and it keeps them in transactions so that two app instances (or an instance and a
// runner API handler) cannot interleave halfway.
//
// Every public operation that reads before it writes runs in one transaction. Transactions on this
// database take the write lock up front (`begin immediate`, see `dialect.ts`), so the check "is there
// a job already?" and the insert that follows it cannot be separated by another writer.
import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { ExpressionBuilder, Kysely } from "kysely";
import { REVIEW_COMMANDS, type JsonValue } from "../../integrations/types.ts";
import {
  DEFAULT_JOB_QUEUE_LIMITS,
  type JobQueueLimits,
} from "../../jobs/job-limits.ts";
import type { ValidEnqueueInput } from "../../jobs/job-input.ts";
import {
  SLOT_HOLDING_STATUSES,
  isJobStatus,
  statusesThatCanBecome,
  type JobStatus,
} from "../../jobs/job-status.ts";
import {
  JOB_TRIGGER_KINDS,
  type CancelClaimedResult,
  type ClaimResult,
  type CompleteResult,
  type EnqueueResult,
  type HeartbeatResult,
  type Job,
  type JobErrorCode,
  type JobOutcome,
  type ReleaseResult,
} from "../../jobs/job-types.ts";
import { decodeJson, encodeJson, formatTimestamp } from "../codecs.ts";
import type { Database, JobsTable } from "../schema.ts";
import { claimOldestDueJob } from "./jobs-claim.ts";

/** What `expireStaleJobs` did. */
export type ExpiryReport = {
  /** Running jobs whose lease ran out and that were put back in the queue. */
  requeued: number;
  /** Running jobs whose lease ran out on the last allowed attempt. */
  leaseExpired: number;
  /** Running jobs that ran longer than the hard limit. */
  timedOut: number;
};

export type JobListFilter = {
  repositoryId?: string;
  prNumber?: number;
  status?: JobStatus | JobStatus[];
  /** At most this many jobs, oldest first. Defaults to 100 and is capped at 500. */
  limit?: number;
};

export const JOB_LIST_DEFAULT_LIMIT = 100;
export const JOB_LIST_MAX_LIMIT = 500;

export type JobsRepositoryOptions = {
  now?: () => Date;
  newId?: () => string;
  /** The random lease token of a claim. */
  newToken?: () => string;
  limits?: Partial<JobQueueLimits>;
};

export type JobsRepository = {
  /** Inserts a job unless the dedupe rules say one exists already; see the README of `src/jobs`. */
  enqueue(input: ValidEnqueueInput): Promise<EnqueueResult>;
  /**
   * Expires stale leases and runtimes, then hands the oldest due job to the runner (or null). The
   * result carries the lease token the runner must present from then on.
   */
  claimNext(runnerId: string): Promise<ClaimResult>;
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
  /** Cancels every waiting job of a repository (its project was deactivated); returns how many. */
  cancelWaitingForRepository(repositoryId: string): Promise<number>;
  /** Cancels the waiting jobs of one pull request (it was closed); returns how many. */
  discardWaitingForPr(repositoryId: string, prNumber: number): Promise<number>;
  discardWaitingAutomaticForPr(
    repositoryId: string,
    prNumber: number,
  ): Promise<number>;
  get(id: string): Promise<Job | undefined>;
  list(filter?: JobListFilter): Promise<Job[]>;
};

function toJob(row: JobsTable): Job {
  if (!isJobStatus(row.status))
    throw new Error(
      `Stored job ${row.id} has the unknown status "${row.status}".`,
    );
  const command = REVIEW_COMMANDS.find((known) => known === row.command);
  if (command === undefined)
    throw new Error(
      `Stored job ${row.id} has the unknown command "${row.command}".`,
    );
  const triggerKind = JOB_TRIGGER_KINDS.find(
    (kind) => kind === row.trigger_kind,
  );
  if (triggerKind === undefined)
    throw new Error(
      `Stored job ${row.id} has the unknown trigger kind "${row.trigger_kind}".`,
    );
  return {
    id: row.id,
    repositoryId: row.repository_id,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    headSha: row.head_sha,
    command,
    args: row.args,
    triggerKind,
    actorLogin: row.actor_login,
    deliveryId: row.delivery_id,
    status: row.status,
    runAfter: row.run_after,
    attempts: row.attempts,
    runnerId: row.runner_id,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    result: row.result === null ? null : decodeJson<JsonValue>(row.result),
    errorCode: row.error_code,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

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

export function createJobsRepository(
  db: Kysely<Database>,
  options: JobsRepositoryOptions = {},
): JobsRepository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const newToken = options.newToken ?? (() => crypto.randomUUID());
  const limits = { ...DEFAULT_JOB_QUEUE_LIMITS, ...options.limits };

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

  async function expire(
    executor: Kysely<Database>,
    current: Date,
  ): Promise<ExpiryReport> {
    const timestamp = formatTimestamp(current);
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
    };
  }

  async function cancelWaiting(
    where: {
      repositoryId: string;
      prNumber?: number;
      /** Only jobs a webhook created (`trigger_kind = webhook`), not the ones a person started. */
      automaticOnly?: boolean;
    },
    errorCode: JobErrorCode,
  ): Promise<number> {
    const timestamp = formatTimestamp(now());
    let query = db
      .updateTable("jobs")
      .set({
        status: "cancelled",
        error_code: errorCode,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where("status", "in", statusesThatCanBecome("cancelled"))
      .where("repository_id", "=", where.repositoryId);
    if (where.prNumber !== undefined)
      query = query.where("pr_number", "=", where.prNumber);
    if (where.automaticOnly === true)
      query = query.where("trigger_kind", "=", "webhook");
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  return {
    enqueue(input) {
      return inTransaction<EnqueueResult>(async (trx) => {
        const current = now();
        const timestamp = formatTimestamp(current);

        // 1. The same delivery again (GitHub's "Redeliver", or a request that ran twice).
        if (input.deliveryId !== null) {
          const sameDelivery = await trx
            .selectFrom("jobs")
            .selectAll()
            .where("delivery_id", "=", input.deliveryId)
            .executeTakeFirst();
          if (sameDelivery !== undefined)
            return {
              status: "existing",
              job: toJob(sameDelivery),
              reason: "same_delivery",
            };
        }

        const samePullRequest = () =>
          trx
            .selectFrom("jobs")
            .selectAll()
            .where("repository_id", "=", input.repositoryId)
            .where("pr_number", "=", input.prNumber)
            .where("command", "=", input.command);

        if (input.triggerKind === "webhook") {
          // 2. One automatic job per head commit and command, whatever became of it, unless it was
          // replaced or cancelled (then the slot is free again).
          const sameHead = await samePullRequest()
            .where("head_sha", "=", input.headSha)
            .where("trigger_kind", "=", "webhook")
            .where("status", "in", [...SLOT_HOLDING_STATUSES])
            .executeTakeFirst();
          if (sameHead !== undefined)
            return {
              status: "existing",
              job: toJob(sameHead),
              reason: "same_head",
            };
        } else {
          // 2. A job started by a person never duplicates one that is still waiting or running.
          const active = await samePullRequest()
            .where("args", "=", input.args)
            .where("status", "in", ["queued", "running"])
            .orderBy("created_at")
            .orderBy("id")
            .executeTakeFirst();
          if (active !== undefined) {
            // A person does not wait for a debounce: a waiting job that was held back (an automatic
            // job after `synchronize`) is due now.
            const pulledForward =
              active.status === "queued" &&
              active.run_after > timestamp &&
              (await trx
                .updateTable("jobs")
                .set({ run_after: timestamp, updated_at: timestamp })
                .where("id", "=", active.id)
                .where("status", "=", "queued")
                .returningAll()
                .executeTakeFirst());
            return {
              status: "existing",
              job: toJob(pulledForward || active),
              reason: "already_active",
            };
          }
        }

        // 3. The new job.
        const id = newId();
        const inserted = await trx
          .insertInto("jobs")
          .values({
            id,
            repository_id: input.repositoryId,
            pr_number: input.prNumber,
            pr_url: input.prUrl,
            head_sha: input.headSha,
            command: input.command,
            args: input.args,
            trigger_kind: input.triggerKind,
            actor_login: input.actorLogin,
            delivery_id: input.deliveryId,
            status: "queued",
            run_after: formatTimestamp(input.runAfter ?? current),
            attempts: 0,
            runner_id: null,
            lease_token: null,
            claimed_at: null,
            heartbeat_at: null,
            lease_expires_at: null,
            result: null,
            error_code: null,
            superseded_by: null,
            created_at: timestamp,
            updated_at: timestamp,
            finished_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        // 4. An automatic job replaces the waiting automatic jobs of the same pull request, command
        // and arguments: they would review an older state. Jobs a person asked for are never
        // replaced (they skip the debounce an automatic job waits out), and a running job is left
        // alone.
        let supersededJobIds: string[] = [];
        if (input.triggerKind === "webhook") {
          const waiting = await samePullRequest()
            .select("id")
            .where("args", "=", input.args)
            .where("trigger_kind", "=", "webhook")
            .where("status", "in", statusesThatCanBecome("superseded"))
            .where("id", "!=", id)
            .execute();
          supersededJobIds = waiting.map((row) => row.id);
          if (supersededJobIds.length > 0)
            await trx
              .updateTable("jobs")
              .set({
                status: "superseded",
                superseded_by: id,
                finished_at: timestamp,
                updated_at: timestamp,
              })
              .where("id", "in", supersededJobIds)
              .where("status", "in", statusesThatCanBecome("superseded"))
              .execute();
        }

        return { status: "created", job: toJob(inserted), supersededJobIds };
      });
    },

    claimNext(runnerId) {
      return inTransaction(async (trx) => {
        const current = now();
        await expire(trx, current);
        const leaseToken = newToken();
        const row = await claimOldestDueJob(trx, {
          runnerId,
          leaseToken,
          now: current,
          leaseExpiresAt: new Date(current.getTime() + limits.leaseMs),
        });
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

    cancelWaitingForRepository(repositoryId) {
      return cancelWaiting({ repositoryId }, "project_deactivated");
    },

    discardWaitingForPr(repositoryId, prNumber) {
      return cancelWaiting({ repositoryId, prNumber }, "pull_request_closed");
    },

    discardWaitingAutomaticForPr(repositoryId, prNumber) {
      return cancelWaiting(
        { repositoryId, prNumber, automaticOnly: true },
        "pull_request_draft",
      );
    },

    async get(id) {
      const row = await db
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toJob(row);
    },

    async list(filter = {}) {
      let query = db.selectFrom("jobs").selectAll();
      if (filter.repositoryId !== undefined)
        query = query.where("repository_id", "=", filter.repositoryId);
      if (filter.prNumber !== undefined)
        query = query.where("pr_number", "=", filter.prNumber);
      if (filter.status !== undefined)
        query = query.where(
          "status",
          "in",
          Array.isArray(filter.status) ? filter.status : [filter.status],
        );
      const limit = Math.min(
        Math.max(1, Math.trunc(filter.limit ?? JOB_LIST_DEFAULT_LIMIT)),
        JOB_LIST_MAX_LIMIT,
      );
      const rows = await query
        .orderBy("created_at")
        .orderBy("id")
        .limit(limit)
        .execute();
      return rows.map(toJob);
    },
  };
}
