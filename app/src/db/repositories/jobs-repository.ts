// SPDX-License-Identifier: Apache-2.0

// Access to the jobs table of ONE workspace (the factory takes the workspace id; see
// ../workspace-scope.ts): creating jobs, dropping waiting ones, reading them. The lease side of the
// queue (claim, heartbeat, complete, release, expiry) is not scoped, because runners serve the whole
// instance: it lives in runner-jobs-repository.ts. Together they are the only code that reads or
// writes the table. The rules of the queue are described in `src/jobs/README.md`; they are enforced
// here and there, in transactions, so that two app instances (or an instance and a runner API
// handler) cannot interleave halfway.
//
// Every public operation that reads before it writes runs in one transaction. Transactions on this
// database take the write lock up front (`begin immediate`, see `dialect.ts`), so the check "is there
// a job already?" and the insert that follows it cannot be separated by another writer.
import "server-only";
import {
  lockDynamicReviewGate,
  lockJobRowsInOrder,
} from "../dynamic-review-lock.ts";
import type { Kysely, Selectable } from "kysely";
import {
  STORED_REVIEW_COMMANDS,
  type JsonValue,
} from "../../integrations/types.ts";
import {
  PROJECT_REVIEW_KINDS,
  type ProjectReviewKind,
} from "../../review-settings/settings.ts";
import type { ValidEnqueueInput } from "../../jobs/job-input.ts";
import {
  createInstanceDynamicReviewGate,
  type DynamicReviewGate,
} from "../../jobs/dynamic-review-gate.ts";
import {
  createStoredReviewKindResolver,
  type ReviewKindResolver,
} from "../../jobs/review-kind.ts";
import {
  SLOT_HOLDING_STATUSES,
  isJobStatus,
  statusesThatCanBecome,
  type JobStatus,
} from "../../jobs/job-status.ts";
import {
  JOB_TRIGGER_KINDS,
  type EnqueueResult,
  type Job,
  type JobErrorCode,
} from "../../jobs/job-types.ts";
import { databaseDriver } from "../driver.ts";
import { decodeJson, formatTimestamp } from "../codecs.ts";
import type { Database, JobsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

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
  /**
   * #195: resolves a job's review kind from the project's settings, inside the enqueue transaction so
   * it cannot race a settings change. Defaults to the stored project settings.
   */
  reviewKind?: ReviewKindResolver;
  /**
   * #195 rollout gate: whether Dynamic Review may be queued. Default: the instance setting, off.
   */
  dynamicReviewEnabled?: DynamicReviewGate;
};

export type JobsRepository = {
  /** Inserts a job unless the dedupe rules say one exists already; see the README of `src/jobs`. */
  enqueue(input: ValidEnqueueInput): Promise<EnqueueResult>;
  /** Cancels every waiting job of a repository (its project was deactivated); returns how many. */
  cancelWaitingForRepository(repositoryId: string): Promise<number>;
  /**
   * Cancels every waiting job of a repository because its project's review kind changed (#195):
   * they were queued for the other engine. Running jobs finish.
   */
  cancelWaitingForReviewKindChange(repositoryId: string): Promise<number>;
  /** Cancels the waiting jobs of one pull request (it was closed); returns how many. */
  discardWaitingForPr(repositoryId: string, prNumber: number): Promise<number>;
  discardWaitingAutomaticForPr(
    repositoryId: string,
    prNumber: number,
  ): Promise<number>;
  get(id: string): Promise<Job | undefined>;
  list(filter?: JobListFilter): Promise<Job[]>;
};

/**
 * The three columns that hold a fixed vocabulary, decoded; a stored value this version does not know
 * is a bug or a database from the future, and fails loudly. Also used by the read side
 * (`runs-repository.ts`).
 */
export function decodeJobVocabulary(
  row: Pick<JobsTable, "id" | "status" | "command" | "trigger_kind">,
) {
  if (!isJobStatus(row.status))
    throw new Error(
      `Stored job ${row.id} has the unknown status "${row.status}".`,
    );
  const command = STORED_REVIEW_COMMANDS.find((known) => known === row.command);
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
  return { status: row.status, command, triggerKind };
}

/** The stored review kind of a job (#195); a value this version does not know fails loudly. */
export function decodeReviewKind(row: {
  id: string;
  review_kind: string;
}): ProjectReviewKind {
  const kind = PROJECT_REVIEW_KINDS.find((known) => known === row.review_kind);
  if (kind === undefined)
    throw new Error(
      `Stored job ${row.id} has the unknown review kind "${row.review_kind}".`,
    );
  return kind;
}

/** A stored row as the rest of the app sees it; also used by the read side (`runs-repository.ts`). */
export function toJob(row: Selectable<JobsTable>): Job {
  const { status, command, triggerKind } = decodeJobVocabulary(row);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    headSha: row.head_sha,
    reviewKind: decodeReviewKind(row),
    command,
    args: row.args,
    triggerKind,
    actorLogin: row.actor_login,
    deliveryId: row.delivery_id,
    status,
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
  workspaceId: WorkspaceId,
  options: JobsRepositoryOptions = {},
): JobsRepository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const resolveReviewKind =
    options.reviewKind ?? createStoredReviewKindResolver(workspaceId, now);
  const dynamicReviewAllowed =
    options.dynamicReviewEnabled ?? createInstanceDynamicReviewGate();

  // A transaction cannot start another one; inside one, just use it.
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    const guarded = async (trx: Kysely<Database>) => {
      await lockDynamicReviewGate(trx, false);
      return run(trx);
    };
    return db.isTransaction ? guarded(db) : db.transaction().execute(guarded);
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
    return inTransaction(async (trx) => {
      const timestamp = formatTimestamp(now());
      let query = trx
        .updateTable("jobs")
        .set({
          status: "cancelled",
          error_code: errorCode,
          finished_at: timestamp,
          updated_at: timestamp,
        })
        .where("workspace_id", "=", workspaceId)
        .where("status", "in", statusesThatCanBecome("cancelled"))
        .where("repository_id", "=", where.repositoryId);
      if (where.prNumber !== undefined)
        query = query.where("pr_number", "=", where.prNumber);
      if (where.automaticOnly === true)
        query = query.where("trigger_kind", "=", "webhook");
      await lockJobRowsInOrder(
        trx,
        trx
          .selectFrom("jobs")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("repository_id", "=", where.repositoryId)
          .where("status", "=", "queued"),
      );
      const result = await query.executeTakeFirst();
      return Number(result.numUpdatedRows);
    });
  }

  return {
    enqueue(input) {
      return inTransaction<EnqueueResult>(async (trx) => {
        const current = now();
        const timestamp = formatTimestamp(current);

        // Settings saves lock this same workspace-scoped row, including before a project exists.
        const repository = trx
          .selectFrom("repositories")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", input.repositoryId);
        await (
          databaseDriver(trx) === "postgres"
            ? repository.forUpdate()
            : repository
        ).executeTakeFirst();

        await lockJobRowsInOrder(
          trx,
          trx
            .selectFrom("jobs")
            .select("id")
            .where("workspace_id", "=", workspaceId)
            .where("repository_id", "=", input.repositoryId)
            .where("status", "in", ["queued", "running"]),
        );

        // #195 (finding 3): resolve the kind here, in the same transaction as the insert, so a
        // concurrent settings change cannot slip between the read and the write. A kind named by the
        // caller (tests, a re-queue) wins.
        const reviewKind =
          input.reviewKind ??
          (await resolveReviewKind(trx, input.repositoryId));
        // #195 rollout gate: with Dynamic Review off, the job is created failed instead of queued, so
        // a previous-release app can never claim a Dynamic row as Diff and no run is silently a Diff
        // review.
        const dynamicDisabled =
          reviewKind === "dynamic" && !(await dynamicReviewAllowed(trx));

        // 1. The same delivery again (GitHub's "Redeliver", or a request that ran twice).
        if (input.deliveryId !== null) {
          const sameDelivery = await trx
            .selectFrom("jobs")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .where("delivery_id", "=", input.deliveryId)
            .executeTakeFirst();
          if (sameDelivery !== undefined)
            return {
              status: "existing",
              job: toJob(sameDelivery),
              reason: "same_delivery",
            };
        }

        // 1b. The same comment again, under another delivery id (a replayed signed body, or two
        // deliveries of one comment): one answer per comment, whatever became of its job.
        if (input.commentId !== null) {
          const sameComment = await trx
            .selectFrom("job_comments")
            .innerJoin("jobs", "jobs.id", "job_comments.job_id")
            .selectAll("jobs")
            .where("jobs.workspace_id", "=", workspaceId)
            .where("job_comments.repository_id", "=", input.repositoryId)
            .where("job_comments.comment_id", "=", input.commentId)
            .executeTakeFirst();
          if (sameComment !== undefined)
            return {
              status: "existing",
              job: toJob(sameComment),
              reason: "same_comment",
            };
        }

        // The comment is answered by the job that comes out of the steps below, a new one or an
        // equal one that exists already; either way the comment is recorded, so its replay finds it.
        const recordComment = async (jobId: string) => {
          if (input.commentId === null) return;
          await trx
            .insertInto("job_comments")
            .values({
              repository_id: input.repositoryId,
              comment_id: input.commentId,
              job_id: jobId,
            })
            .execute();
        };

        const samePullRequest = () =>
          trx
            .selectFrom("jobs")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .where("repository_id", "=", input.repositoryId)
            .where("pr_number", "=", input.prNumber)
            .where("command", "=", input.command)
            // #195: a Diff job and a Dynamic job are different jobs. Dedupe and supersession must
            // never treat one kind's job as a duplicate of the other's.
            .where("review_kind", "=", reviewKind);

        if (input.triggerKind === "webhook") {
          // 2. One automatic job per head commit and command, whatever became of it, unless it was
          // replaced or cancelled (then the slot is free again).
          const sameHead = await samePullRequest()
            .where("head_sha", "=", input.headSha)
            .where("trigger_kind", "=", "webhook")
            .where("status", "in", [...SLOT_HOLDING_STATUSES])
            .executeTakeFirst();
          if (sameHead !== undefined) {
            await recordComment(sameHead.id);
            return {
              status: "existing",
              job: toJob(sameHead),
              reason: "same_head",
            };
          }
        } else {
          // 2. A job started by a person never duplicates one that is still waiting or running.
          const active = await samePullRequest()
            .where("args", "=", input.args)
            .where("status", "in", ["queued", "running"])
            .orderBy("created_at")
            .orderBy("id")
            .executeTakeFirst();
          if (active !== undefined) {
            await recordComment(active.id);
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

        // 3. The new job. With Dynamic Review gated off, it is created already failed so the run is
        // visible (Runs) and no runner is ever handed a Dynamic row.
        const id = newId();
        const inserted = await trx
          .insertInto("jobs")
          .values({
            id,
            workspace_id: workspaceId,
            repository_id: input.repositoryId,
            pr_number: input.prNumber,
            pr_url: input.prUrl,
            head_sha: input.headSha,
            command: input.command,
            review_kind: reviewKind,
            args: input.args,
            trigger_kind: input.triggerKind,
            actor_login: input.actorLogin,
            delivery_id: input.deliveryId,
            status: dynamicDisabled ? "failed" : "queued",
            run_after: formatTimestamp(input.runAfter ?? current),
            attempts: 0,
            runner_id: null,
            lease_token: null,
            claimed_at: null,
            heartbeat_at: null,
            lease_expires_at: null,
            result: null,
            error_code: dynamicDisabled ? "dynamic_review_disabled" : null,
            superseded_by: null,
            created_at: timestamp,
            updated_at: timestamp,
            finished_at: dynamicDisabled ? timestamp : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await recordComment(id);

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

    cancelWaitingForRepository(repositoryId) {
      return cancelWaiting({ repositoryId }, "project_deactivated");
    },

    // #195: the project's review kind changed (Diff <-> Dynamic), so every waiting job of the
    // repository was queued for the wrong engine. The settings change and this cancellation run in
    // one transaction (the #194 hook), so a failed save keeps the kind and the jobs. A running job
    // finishes.
    cancelWaitingForReviewKindChange(repositoryId) {
      return cancelWaiting({ repositoryId }, "review_kind_changed");
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
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toJob(row);
    },

    async list(filter = {}) {
      let query = db
        .selectFrom("jobs")
        .selectAll()
        .where("workspace_id", "=", workspaceId);
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
