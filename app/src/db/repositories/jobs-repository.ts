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
import type { Kysely } from "kysely";
import { REVIEW_COMMANDS, type JsonValue } from "../../integrations/types.ts";
import {
  DEFAULT_JOB_QUEUE_LIMITS,
  type JobQueueLimits,
} from "../../jobs/job-limits.ts";
import type { ValidEnqueueInput } from "../../jobs/job-input.ts";
import {
  isJobStatus,
  statusesThatCanBecome,
  type JobStatus,
} from "../../jobs/job-status.ts";
import {
  JOB_TRIGGER_KINDS,
  type ClaimResult,
  type CompleteResult,
  type EnqueueResult,
  type HeartbeatResult,
  type Job,
  type JobOutcome,
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
};

export type JobsRepositoryOptions = {
  now?: () => Date;
  newId?: () => string;
  limits?: Partial<JobQueueLimits>;
};

/** The statuses in which an automatic job occupies its (pull request, head commit, command) slot. */
const SLOT_HOLDING_STATUSES: JobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
];

export type JobsRepository = {
  /** Inserts a job unless the dedupe rules say one exists already; see the README of `src/jobs`. */
  enqueue(input: ValidEnqueueInput): Promise<EnqueueResult>;
  /** Expires stale leases and runtimes, then hands the oldest due job to the runner (or null). */
  claimNext(runnerId: string): Promise<ClaimResult>;
  /** Extends the lease of a job the runner holds. */
  heartbeat(jobId: string, runnerId: string): Promise<HeartbeatResult>;
  /** Finishes a job the runner holds. Reporting the same outcome again is not an error. */
  complete(
    jobId: string,
    runnerId: string,
    outcome: JobOutcome,
  ): Promise<CompleteResult>;
  /** Deals with leases and runtimes that ran out. `claimNext` does this first on every call. */
  expireStaleJobs(): Promise<ExpiryReport>;
  /** Cancels every waiting job of a repository (its project was deactivated); returns how many. */
  cancelWaitingForRepository(repositoryId: string): Promise<number>;
  /** Cancels the waiting jobs of one pull request (it was closed); returns how many. */
  discardWaitingForPr(repositoryId: string, prNumber: number): Promise<number>;
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

export function createJobsRepository(
  db: Kysely<Database>,
  options: JobsRepositoryOptions = {},
): JobsRepository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const limits = { ...DEFAULT_JOB_QUEUE_LIMITS, ...options.limits };

  // A transaction cannot start another one; inside one, just use it.
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  }

  async function expire(
    executor: Kysely<Database>,
    current: Date,
  ): Promise<ExpiryReport> {
    const timestamp = formatTimestamp(current);
    const report: ExpiryReport = { requeued: 0, leaseExpired: 0, timedOut: 0 };

    // The last allowed attempt: its lost lease fails the job. Runner and claim time stay on the row
    // so that a late `complete` from the old runner is recognised and refused.
    const failedLeases = await executor
      .updateTable("jobs")
      .set((eb) => ({
        status: "failed",
        attempts: eb("attempts", "+", 1),
        error_code: "lease_expired",
        lease_expires_at: null,
        finished_at: timestamp,
        updated_at: timestamp,
      }))
      .where("status", "=", "running")
      .where("lease_expires_at", "<=", timestamp)
      .where("attempts", ">=", limits.maxAttempts - 1)
      .executeTakeFirst();
    report.leaseExpired = Number(failedLeases.numUpdatedRows);

    // Every other lost lease: back in the queue, the old runner is no longer the holder.
    const requeued = await executor
      .updateTable("jobs")
      .set((eb) => ({
        status: "queued",
        attempts: eb("attempts", "+", 1),
        runner_id: null,
        claimed_at: null,
        heartbeat_at: null,
        lease_expires_at: null,
        updated_at: timestamp,
      }))
      .where("status", "=", "running")
      .where("lease_expires_at", "<=", timestamp)
      .executeTakeFirst();
    report.requeued = Number(requeued.numUpdatedRows);

    // A job whose runner keeps the lease alive but never finishes.
    const startedBefore = formatTimestamp(
      new Date(current.getTime() - limits.maxRuntimeMs),
    );
    const timedOut = await executor
      .updateTable("jobs")
      .set({
        status: "failed",
        error_code: "timeout",
        lease_expires_at: null,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where("status", "=", "running")
      .where("claimed_at", "<=", startedBefore)
      .executeTakeFirst();
    report.timedOut = Number(timedOut.numUpdatedRows);

    return report;
  }

  async function cancelWaiting(
    where: { repositoryId: string; prNumber?: number },
    errorCode: string,
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
            .where("status", "in", SLOT_HOLDING_STATUSES)
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
          if (active !== undefined)
            return {
              status: "existing",
              job: toJob(active),
              reason: "already_active",
            };
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

        // 4. An automatic job replaces the jobs that still wait for the same command on this pull
        // request: they would review an older state. A running job is left alone.
        let supersededJobIds: string[] = [];
        if (input.triggerKind === "webhook") {
          const waiting = await samePullRequest()
            .select("id")
            .where("args", "=", input.args)
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
        const row = await claimOldestDueJob(trx, {
          runnerId,
          now: current,
          leaseExpiresAt: new Date(current.getTime() + limits.leaseMs),
        });
        return row === undefined ? null : { job: toJob(row) };
      });
    },

    async heartbeat(jobId, runnerId) {
      const current = now();
      const timestamp = formatTimestamp(current);
      const row = await db
        .updateTable("jobs")
        .set({
          heartbeat_at: timestamp,
          lease_expires_at: formatTimestamp(
            new Date(current.getTime() + limits.leaseMs),
          ),
          updated_at: timestamp,
        })
        .where("id", "=", jobId)
        .where("status", "=", "running")
        .where("runner_id", "=", runnerId)
        .returningAll()
        .executeTakeFirst();
      return row === undefined
        ? { status: "not_holder" }
        : { status: "ok", job: toJob(row) };
    },

    complete(jobId, runnerId, outcome) {
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
          .where("id", "=", jobId)
          .where("runner_id", "=", runnerId)
          .where("status", "=", "running")
          .returningAll()
          .executeTakeFirst();
        if (finished !== undefined)
          return { status: "completed", job: toJob(finished) };

        // Not running any more: either this runner already reported (same or other outcome), or it
        // never held the job, or it lost it.
        const row = await trx
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", jobId)
          .where("runner_id", "=", runnerId)
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

    expireStaleJobs() {
      return inTransaction((trx) => expire(trx, now()));
    },

    cancelWaitingForRepository(repositoryId) {
      return cancelWaiting({ repositoryId }, "project_deactivated");
    },

    discardWaitingForPr(repositoryId, prNumber) {
      return cancelWaiting({ repositoryId, prNumber }, "pull_request_closed");
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
      const rows = await query.orderBy("created_at").orderBy("id").execute();
      return rows.map(toJob);
    },
  };
}
