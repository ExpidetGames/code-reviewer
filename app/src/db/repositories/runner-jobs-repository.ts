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
import {
  lockDynamicReviewGate,
  lockJobRowsInOrder,
} from "../dynamic-review-lock.ts";
import { createInstanceSettingsRepository } from "./instance-settings-repository.ts";
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
import {
  newLeaseToken,
  newWorkerCredential,
  workerLeaseToken,
} from "../../jobs/worker-credential.ts";
import type {
  CancelClaimedResult,
  ClaimResult,
  CompleteResult,
  CountFetchResult,
  HeartbeatResult,
  Job,
  JobErrorCode,
  JobOutcome,
  ReleaseResult,
} from "../../jobs/job-types.ts";
import { encodeJson, formatTimestamp } from "../codecs.ts";
import { databaseDriver, type DatabaseDriver } from "../driver.ts";
import type { Database } from "../schema.ts";
import { isJobIndependentRefusal } from "../../usage/enforce-entitlements.ts";
import { admitClaimedJob, type ClaimRefusal } from "./claim-admission.ts";
import { claimOldestDueJob, claimOldestDueJobPostgres } from "./jobs-claim.ts";
import { toJob } from "./jobs-repository.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";
import { voidRecordsOfEndedJobs } from "./usage-records-sweep.ts";
import { settlementOfOutcome } from "../../usage/usage-records.ts";

/** What `expireStaleJobs` did. */
export type ExpiryReport = {
  /** Running jobs whose lease ran out and that were put back in the queue. */
  requeued: number;
  /** Expired running leases that ended the job (last attempt, or Dynamic with its gate off). */
  leaseExpired: number;
  /** Running jobs that ran longer than the hard limit. */
  timedOut: number;
  /** Waiting Dynamic jobs no capable runner claimed within the deadline (#195). */
  noCapableRunner: number;
};

export type RunnerJobsRepositoryOptions = {
  now?: () => Date;
  /** The random lease token of a claim (256 bits by default). */
  newToken?: () => string;
  /** #320: the per-job credential of a claim made with `workerCredential`; tests only. */
  newCredential?: () => string;
  limits?: Partial<JobQueueLimits>;
  /** Overrides the engine read from the connection; tests only. */
  driver?: DatabaseDriver;
  /**
   * #277: called for every job a claim refused for the entitlements of its workspace (suspended, a limit used
   * up, entitlements that cannot be read), after the transaction of the claim committed. The job is `failed`
   * already; this is only for the log. A callback that throws is logged (`claim_refusal_log_failed`) and
   * ignored: it can never fail the claim or orphan a job that was claimed in the same call.
   */
  onRefused?: (refusal: ClaimRefusal) => void;
  /**
   * #277: called once per claim and workspace whose entitlements hold a cost limit next to the own key, which
   * nothing reads (an entry stored before that shape was refused on write). Same rules as `onRefused`.
   */
  onIgnoredCostLimit?: (workspaceId: string) => void;
};

/**
 * What a refused job looks like (#277): failed with the code, and as if it never started: no holder, no start
 * time and no lease, so the Runs list shows no duration for a run that "did not start". No attempt is counted.
 */
function refusedJob(errorCode: string, current: Date) {
  const timestamp = formatTimestamp(current);
  return {
    status: "failed",
    error_code: errorCode,
    runner_id: null,
    lease_token: null,
    claimed_at: null,
    heartbeat_at: null,
    lease_expires_at: null,
    finished_at: timestamp,
    updated_at: timestamp,
  } as const;
}

/** Runs a log callback of the claim; one that throws is reported by its stable code, without its message. */
function notify(callback: () => void): void {
  try {
    callback();
  } catch {
    console.error("[queue] claim_refusal_log_failed");
  }
}

/** How many jobs one `claimNext` may refuse before it answers "nothing" and lets the runner ask again. */
const MAX_REFUSED_PER_CLAIM = 25;

export type RunnerJobsRepository = {
  /**
   * Expires stale leases and runtimes, then hands the oldest due job the runner's engines can run to
   * the runner (or null). `engines` defaults to `pr-agent` for a previous-release caller that sends
   * no capability list. The result carries the lease token the runner must present from then on.
   */
  claimNext(
    runnerId: string,
    engines?: readonly RunnerEngine[],
    claimOptions?: ClaimOptions,
  ): Promise<ClaimResult>;
  /**
   * #320: the job `leaseToken` was issued for, whatever its status: the claim that is running, or the
   * claim that ended (the token stays on a finished job, so a late or repeated report is recognised).
   * `undefined` for any other token, including the one of an earlier claim of a job that was queued
   * again. Reads only; the Worker API tells a credential that is not the job's (401) from a job that
   * ended (409) with it.
   */
  holding(jobId: string, leaseToken: string): Promise<Job | undefined>;
  /**
   * #320: counts one fetch of the job details by the Worker of the running claim `leaseToken`
   * belongs to, in one statement, up to `limit` per claim (the claim resets the count).
   */
  countFetch(
    jobId: string,
    leaseToken: string,
    limit: number,
  ): Promise<CountFetchResult>;
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
   * #328: fails every queued job that has waited `waitedMs` or longer, counted from the later of the time it
   * became due and the time it was last queued (a job given back after a lost lease starts waiting again), with
   * the stable code `dispatch_unavailable`. No attempt is counted. A job whose dispatch a Dispatcher
   * acknowledged and that is still inside the acknowledgement window is spared: that Dispatcher is working on
   * it. Returns how many jobs it failed.
   */
  failUndispatched(waitedMs: number): Promise<number>;
  /** #328: how many jobs are running now, of any runner or pool. */
  countRunning(): Promise<number>;
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

/** How a claim is made. */
export type ClaimOptions = {
  /**
   * #320: mint a per-job credential for the claim (256 bits, `crj_`). The queue stores only its hash
   * as the lease token of the claim and returns the credential once, as `credential`.
   */
  workerCredential?: boolean;
  /**
   * #322: claim exactly this job (a Dispatcher woken by the dispatch webhook). Every other rule of the
   * claim applies to it unchanged; a job that cannot be claimed gives `null`.
   */
  jobId?: string;
  /**
   * #322: the pool cap. The pool is the runner id of the claim: when that many jobs with this runner id
   * are running, the claim gives `null`. Counted inside the claim transaction, after lapsed leases were
   * dealt with: see `claimNext`.
   */
  maxRunning?: number;
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
  const newToken = options.newToken ?? newLeaseToken;
  const newCredential = options.newCredential ?? newWorkerCredential;
  const limits = { ...DEFAULT_JOB_QUEUE_LIMITS, ...options.limits };
  const driver = options.driver ?? databaseDriver(db);
  // The transaction guard already holds the exclusive gate lock; read without taking another lock
  // after job rows. This keeps every transition on the documented gate-before-rows order.
  async function dynamicReviewAllowed(
    executor: Kysely<Database>,
  ): Promise<boolean> {
    return (
      (await createInstanceSettingsRepository(executor).get("dynamic_review"))
        ?.enabled === true
    );
  }

  // A transaction cannot start another one; inside one, just use it.
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    const guarded = async (trx: Kysely<Database>) => {
      // The first lock, before any job row: disable and every runner transition serialize here.
      await lockDynamicReviewGate(trx, true);
      return run(trx);
    };
    return db.isTransaction ? guarded(db) : db.transaction().execute(guarded);
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
    let disabled = 0;
    if (!(await dynamicReviewAllowed(executor))) {
      const result = await executor
        .updateTable("jobs")
        .set((eb) => ({
          status: "failed",
          attempts: eb("attempts", "+", 1),
          error_code: "dynamic_review_disabled" satisfies JobErrorCode,
          lease_expires_at: null,
          finished_at: timestamp,
          updated_at: timestamp,
        }))
        .where(runningWhere(scope))
        .where("review_kind", "=", "dynamic")
        .executeTakeFirst();
      disabled = Number(result.numUpdatedRows);
    }
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
      failed: disabled + Number(failed.numUpdatedRows),
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
    // Before the expiry passes or claim: reserve all live candidates in the same row order. The
    // exclusive gate prevents another queue writer from inserting/changing that set meanwhile.
    await lockJobRowsInOrder(
      executor,
      executor
        .selectFrom("jobs")
        .select("id")
        .where("status", "in", ["queued", "running"]),
    );
    if (!(await dynamicReviewAllowed(executor))) {
      await executor
        .updateTable("jobs")
        .set({
          status: "cancelled",
          error_code: "dynamic_review_disabled" satisfies JobErrorCode,
          finished_at: timestamp,
          updated_at: timestamp,
        })
        .where("status", "=", "queued")
        .where("review_kind", "=", "dynamic")
        .execute();
    }
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
    await voidRecordsOfEndedJobs(executor);
    return {
      requeued: lost.requeued,
      leaseExpired: lost.failed,
      timedOut,
      noCapableRunner,
    };
  }

  /** #328: the queued jobs that waited for a claim longer than `waitedMs`; see `failUndispatched`. */
  async function failUndispatched(
    executor: Kysely<Database>,
    current: Date,
    waitedMs: number,
  ): Promise<number> {
    const timestamp = formatTimestamp(current);
    const waitedBefore = formatTimestamp(
      new Date(current.getTime() - waitedMs),
    );
    const waiting = (eb: ExpressionBuilder<Database, "jobs">) =>
      eb.and([
        eb("status", "=", "queued"),
        // Due for that long, and queued (again) for that long: a requeue changes `updated_at`, not `run_after`.
        eb("run_after", "<=", waitedBefore),
        eb("updated_at", "<=", waitedBefore),
        eb.not(
          eb.exists(
            eb
              .selectFrom("job_dispatches")
              .select("job_dispatches.job_id")
              .whereRef("job_dispatches.job_id", "=", "jobs.id")
              .where("job_dispatches.state", "=", "acked")
              .where("job_dispatches.next_dispatch_at", ">", timestamp),
          ),
        ),
      ]);
    await lockJobRowsInOrder(
      executor,
      executor.selectFrom("jobs").select("id").where(waiting),
    );
    const result = await executor
      .updateTable("jobs")
      .set({
        status: "failed",
        error_code: "dispatch_unavailable" satisfies JobErrorCode,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where(waiting)
      .executeTakeFirst();
    await voidRecordsOfEndedJobs(executor);
    return Number(result.numUpdatedRows);
  }

  /** #322: the running jobs of one pool (the runner id of their claim). */
  async function runningInPool(
    executor: Kysely<Database>,
    runnerId: string,
  ): Promise<number> {
    const { count } = await executor
      .selectFrom("jobs")
      .select((eb) => eb.fn.countAll<number | string>().as("count"))
      .where("status", "=", "running")
      .where("runner_id", "=", runnerId)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /**
   * #277: ends the job this claim just took as `failed` with the code of the refusal, in the transaction of the
   * claim. No attempt is counted and no runner heard of it; its record, if it had one, is voided by the caller.
   */
  async function refuseClaimedJob(
    executor: Kysely<Database>,
    jobId: string,
    errorCode: string,
    current: Date,
  ): Promise<void> {
    await executor
      .updateTable("jobs")
      .set(refusedJob(errorCode, current))
      .where("id", "=", jobId)
      .where("status", "=", "running")
      .execute();
  }

  /**
   * #277: a refusal that does not depend on the job (a suspension, entitlements that cannot be read) ends the
   * claimed job and every other due job of the workspace in one statement, so a backlog does not take one round
   * of the claim per job and does not hold the gate lock for as many. Returns the ids it ended.
   */
  async function refuseDueJobsOfWorkspace(
    executor: Kysely<Database>,
    workspaceId: string,
    claimedJobId: string,
    errorCode: string,
    current: Date,
  ): Promise<string[]> {
    const rows = await executor
      .updateTable("jobs")
      .set(refusedJob(errorCode, current))
      .where("workspace_id", "=", workspaceId)
      .where((eb) =>
        eb.or([
          eb.and([eb("id", "=", claimedJobId), eb("status", "=", "running")]),
          eb.and([
            eb("status", "=", "queued"),
            eb("command", "=", "review"),
            eb("run_after", "<=", formatTimestamp(current)),
          ]),
        ]),
      )
      .returning("id")
      .execute();
    return rows.map((row) => row.id);
  }

  return {
    async claimNext(runnerId, engines = DEFAULT_ENGINES, claimOptions = {}) {
      const refusals: ClaimRefusal[] = [];
      const ignoredCostLimits = new Set<string>();
      const claimed = await inTransaction(async (trx) => {
        const current = now();
        await expire(trx, current);
        // The credential is only ever returned; the database gets its hash as the lease token.
        const credential =
          claimOptions.workerCredential === true ? newCredential() : undefined;
        const leaseToken =
          credential === undefined ? newToken() : workerLeaseToken(credential);
        const claim = {
          runnerId,
          leaseToken,
          now: current,
          leaseExpiresAt: new Date(current.getTime() + limits.leaseMs),
        };
        const reviewKinds = reviewKindsForEngines(engines);
        // #322: the pool cap. Atomic because a claim is the only way a job becomes running and every
        // claim runs under the exclusive gate lock of `inTransaction` (Postgres) or the write lock of the
        // connection (SQLite): two claims of one pool cannot both count below the cap and then both
        // claim. The count follows `expire`, so a lapsed lease does not hold a slot.
        if (
          claimOptions.maxRunning !== undefined &&
          (await runningInPool(trx, runnerId)) >= claimOptions.maxRunning
        )
          return null;
        for (let refused = 0; refused < MAX_REFUSED_PER_CLAIM; refused += 1) {
          const row = await (
            driver === "postgres"
              ? claimOldestDueJobPostgres
              : claimOldestDueJob
          )(trx, claim, reviewKinds, claimOptions.jobId);
          if (row === undefined) return null;
          // #277: the limits and the suspension of the job's workspace, decided in this transaction, before
          // the record is reserved: a refused job leaves no record, and two claims cannot both take the
          // last unit of a limit.
          const { admission, hadRecord, ignoredCostLimit } =
            await admitClaimedJob(trx, row, () => current);
          if (ignoredCostLimit) ignoredCostLimits.add(row.workspace_id);
          if (!admission.allow) {
            const detail =
              admission.detail === undefined
                ? {}
                : { detail: admission.detail };
            if (isJobIndependentRefusal(admission.errorCode)) {
              const ended = await refuseDueJobsOfWorkspace(
                trx,
                row.workspace_id,
                row.id,
                admission.errorCode,
                current,
              );
              // Any of them may have had a record that counted (claimed before, lost its lease).
              await voidRecordsOfEndedJobs(trx);
              for (const jobId of ended)
                refusals.push({
                  jobId,
                  workspaceId: row.workspace_id,
                  errorCode: admission.errorCode,
                  ...detail,
                });
              continue;
            }
            await refuseClaimedJob(trx, row.id, admission.errorCode, current);
            // A job claimed again after a lost lease had a record that counted: it ends with the job.
            if (hadRecord) await voidRecordsOfEndedJobs(trx);
            refusals.push({
              jobId: row.id,
              workspaceId: row.workspace_id,
              errorCode: admission.errorCode,
              ...detail,
            });
            continue;
          }
          // The record is reserved in the transaction of the claim, so a job handed out always counts. The
          // key mode is the workspace's own until the claim route has resolved the access (`setKeyMode`); a
          // job claimed again keeps the record it has.
          await createUsageRecordsRepository(
            trx,
            row.workspace_id,
            () => current,
          ).reserve(row.id, "own");
          return {
            job: toJob(row),
            leaseToken,
            ...(credential === undefined ? {} : { credential }),
          };
        }
        // Many jobs in a row were refused; the runner asks again.
        return null;
      });
      // After the commit, and never able to fail it: a claimed job is already running under its lease.
      for (const refusal of refusals)
        notify(() => options.onRefused?.(refusal));
      for (const workspaceId of ignoredCostLimits)
        notify(() => options.onIgnoredCostLimit?.(workspaceId));
      return claimed;
    },

    async holding(jobId, leaseToken) {
      const row = await db
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", jobId)
        .where("lease_token", "=", leaseToken)
        .executeTakeFirst();
      return row === undefined ? undefined : toJob(row);
    },

    countFetch(jobId, leaseToken, limit) {
      return inTransaction<CountFetchResult>(async (trx) => {
        const counted = await trx
          .updateTable("jobs")
          .set((eb) => ({ worker_fetches: eb("worker_fetches", "+", 1) }))
          .where(runningWhere({ claim: { jobId, leaseToken } }))
          .where("worker_fetches", "<", limit)
          .returning("id")
          .executeTakeFirst();
        if (counted !== undefined) return "counted";
        // Not counted: either the fetches are used up, or the caller does not hold the running claim.
        const held = await trx
          .selectFrom("jobs")
          .select("id")
          .where(runningWhere({ claim: { jobId, leaseToken } }))
          .executeTakeFirst();
        return held === undefined ? "not_holder" : "exhausted";
      });
    },

    heartbeat(jobId, leaseToken) {
      return inTransaction<HeartbeatResult>(async (trx) => {
        const current = now();
        const timestamp = formatTimestamp(current);
        // The hard limit does not depend on anyone else's claim: the holder that is past it learns
        // so here, and the job fails.
        const timedOut = await failTimedOut(
          trx,
          { claim: { jobId, leaseToken } },
          current,
        );
        if (timedOut > 0) await voidRecordsOfEndedJobs(trx);
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
        if (finished !== undefined) {
          // Settled from what the runner reported, in the same transaction as the job's end.
          await createUsageRecordsRepository(
            trx,
            finished.workspace_id,
            now,
          ).settle(finished.id, settlementOfOutcome(outcome));
          return { status: "completed", job: toJob(finished) };
        }

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
        if (removed !== undefined) {
          await voidRecordsOfEndedJobs(trx);
          return { status: "cancelled", job: toJob(removed) };
        }
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
        await voidRecordsOfEndedJobs(trx);
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

    failUndispatched(waitedMs) {
      return inTransaction((trx) => failUndispatched(trx, now(), waitedMs));
    },

    async countRunning() {
      const { count } = await db
        .selectFrom("jobs")
        .select((eb) => eb.fn.countAll<number | string>().as("count"))
        .where("status", "=", "running")
        .executeTakeFirstOrThrow();
      return Number(count);
    },

    cancelClaimed(jobId, leaseToken, errorCode) {
      return inTransaction<CancelClaimedResult>(async (trx) => {
        const timestamp = formatTimestamp(now());
        // Not a transition of the shared table (`canTransition`): `cancelWaiting` derives its statuses
        // from that table and a deactivation must never cancel running jobs. This one statement is the
        // only way a running job becomes cancelled, and only for the holder of the claim.
        const row = await trx
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
        if (row === undefined) return { status: "not_holder" };
        await voidRecordsOfEndedJobs(trx);
        return { status: "cancelled", job: toJob(row) };
      });
    },
  };
}
