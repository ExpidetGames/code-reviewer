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
import { SUPERSEDED_REPORT_GRACE_MS } from "../../jobs/supersede-timing.ts";
import { isJobIndependentRefusal } from "../../usage/enforce-entitlements.ts";
import { admitClaimedJob, type ClaimRefusal } from "./claim-admission.ts";
import { claimOldestDueJob, claimOldestDueJobPostgres } from "./jobs-claim.ts";
import { toJob } from "./jobs-repository.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";
import { closeRecordsOfEndedJobs } from "./usage-records-sweep.ts";
import {
  settlementOfOutcome,
  settlementOfSupersededOutcome,
  type UnknownCostSettlement,
} from "../../usage/usage-records.ts";

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
  /**
   * #361: called once for every usage record that settled without a known cost, after the transaction that settled
   * it committed. A cost limit does not bound such a run, so this is the signal to watch them: ids only, never a
   * figure or a name. Same rules as `onRefused` (a callback that throws is logged and ignored).
   */
  onUnknownCostSettled?: (settlement: UnknownCostSettlement) => void;
  /**
   * #487: called once per call that ended the claims of jobs for good, with the ids of the jobs, after the transaction
   * that ended them committed: a result, a failure or a cancel reported by the holder, a job given back on its last
   * attempt, a heartbeat past the hard limit, and the leases and runtimes that ran out and ended the job (in
   * `expireStaleJobs` and in the expiry step of a claim). The running server tells the Dispatcher to stop those jobs'
   * VMs. A job that went back to the queue is **not** named: the Dispatcher stops by job, and the next attempt's VM may
   * exist by the time the call arrives; the VM of the lost attempt lives until its own timeout or the job's final stop (the reaper
   * ends it earlier only while the retry is not `running`). Same rules as
   * `onRefused`: a callback that throws is logged and ignored, and a repository that joined a caller's transaction calls
   * it never (it cannot see the commit).
   */
  onClaimsEnded?: (jobIds: readonly string[]) => void;
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

/** Runs a callback of the queue; one that throws is reported by the given stable code, without its message. */
function notify(code: string, callback: () => void): void {
  try {
    callback();
  } catch {
    console.error(`[queue] ${code}`);
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
  /**
   * #397: notes that the holder of the running claim `leaseToken` belongs to understands that its run can be
   * superseded. One statement fenced by the token; false for any other token or a job that is not running.
   */
  noteSupersede(jobId: string, leaseToken: string): Promise<boolean>;
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
  /**
   * #397: the caller understands that its run can be superseded (the claim named the feature `supersede`). A running
   * job is superseded by a newer push only then; a Worker says so with its job details request instead
   * (`noteSupersede`).
   */
  acceptsSupersede?: boolean;
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
   * A transaction that collects the runs it settled without a known cost and reports them once it committed
   * (#361): the alert never fires for a transaction that rolled back. Only the repository that opens the transaction
   * itself reports: one built on a database that is already a transaction (`db.isTransaction`) joins its caller's
   * transaction, whose commit it cannot see, so it reports nothing rather than something that may be rolled back.
   */
  async function inAlertingTransaction<T>(
    run: (
      executor: Kysely<Database>,
      unknownCost: UnknownCostSettlement[],
      endedClaims: string[],
    ) => Promise<T>,
  ): Promise<T> {
    const unknownCost: UnknownCostSettlement[] = [];
    const endedClaims: string[] = [];
    const result = await inTransaction((trx) =>
      run(trx, unknownCost, endedClaims),
    );
    if (db.isTransaction) return result;
    for (const settlement of unknownCost)
      notify("unknown_cost_callback_failed", () =>
        options.onUnknownCostSettled?.(settlement),
      );
    if (endedClaims.length > 0)
      notify("claims_ended_callback_failed", () =>
        options.onClaimsEnded?.(endedClaims),
      );
    return result;
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

  /**
   * #487: the running jobs whose claim the passes of `expire` act on: the lease ran out or the runtime is past the hard
   * limit. Read after the rows were reserved and before the passes change them, so it is the set they act on.
   */
  async function claimsEndingByExpiry(
    executor: Kysely<Database>,
    current: Date,
  ): Promise<string[]> {
    const timestamp = formatTimestamp(current);
    const startedBefore = formatTimestamp(
      new Date(current.getTime() - limits.maxRuntimeMs),
    );
    const rows = await executor
      .selectFrom("jobs")
      .select("id")
      .where("status", "=", "running")
      .where((eb) =>
        eb.or([
          eb("lease_expires_at", "<=", timestamp),
          eb("claimed_at", "<=", startedBefore),
        ]),
      )
      .execute();
    return rows.map((row) => row.id);
  }

  async function expire(
    executor: Kysely<Database>,
    current: Date,
    unknownCost: UnknownCostSettlement[],
    endedClaims: string[],
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
    const expiring = await claimsEndingByExpiry(executor, current);
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
    unknownCost.push(...(await closeRecordsOfEndedJobs(executor, timestamp)));
    // Only the jobs that are over: one that went back to the queue gets a new claim, and its VM must not be stopped.
    if (expiring.length > 0)
      endedClaims.push(
        ...(
          await executor
            .selectFrom("jobs")
            .select("id")
            .where("id", "in", expiring)
            .where("status", "<>", "queued")
            .execute()
        ).map((row) => row.id),
      );
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
    unknownCost: UnknownCostSettlement[],
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
    unknownCost.push(...(await closeRecordsOfEndedJobs(executor, timestamp)));
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
  ): Promise<
    Array<{
      id: string;
      repository_id: string;
      pr_number: number;
      trigger_kind: string;
    }>
  > {
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
      .returning(["id", "repository_id", "pr_number", "trigger_kind"])
      .execute();
    return rows;
  }

  return {
    async claimNext(runnerId, engines = DEFAULT_ENGINES, claimOptions = {}) {
      const refusals: ClaimRefusal[] = [];
      const ignoredCostLimits = new Set<string>();
      const claimed = await inAlertingTransaction(
        async (trx, unknownCost, endedClaims) => {
          const current = now();
          await expire(trx, current, unknownCost, endedClaims);
          // The credential is only ever returned; the database gets its hash as the lease token.
          const credential =
            claimOptions.workerCredential === true
              ? newCredential()
              : undefined;
          const leaseToken =
            credential === undefined
              ? newToken()
              : workerLeaseToken(credential);
          const claim = {
            runnerId,
            leaseToken,
            now: current,
            leaseExpiresAt: new Date(current.getTime() + limits.leaseMs),
            ...(claimOptions.acceptsSupersede === true
              ? { acceptsSupersede: true }
              : {}),
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
              const detail = {
                ...(admission.detail === undefined
                  ? {}
                  : { detail: admission.detail }),
                ...(admission.periodStart === undefined
                  ? {}
                  : { periodStart: admission.periodStart }),
              };
              if (isJobIndependentRefusal(admission.errorCode)) {
                const ended = await refuseDueJobsOfWorkspace(
                  trx,
                  row.workspace_id,
                  row.id,
                  admission.errorCode,
                  current,
                );
                // Any of them may have had a record that counted (claimed before, lost its lease).
                unknownCost.push(
                  ...(await closeRecordsOfEndedJobs(
                    trx,
                    formatTimestamp(current),
                  )),
                );
                for (const job of ended)
                  refusals.push({
                    jobId: job.id,
                    workspaceId: row.workspace_id,
                    repositoryId: job.repository_id,
                    prNumber: job.pr_number,
                    triggerKind: job.trigger_kind,
                    errorCode: admission.errorCode,
                    ...detail,
                  });
                continue;
              }
              await refuseClaimedJob(trx, row.id, admission.errorCode, current);
              // A job claimed again after a lost lease had a record that counted: it ends with the job.
              if (hadRecord)
                unknownCost.push(
                  ...(await closeRecordsOfEndedJobs(
                    trx,
                    formatTimestamp(current),
                  )),
                );
              refusals.push({
                jobId: row.id,
                workspaceId: row.workspace_id,
                repositoryId: row.repository_id,
                prNumber: row.pr_number,
                triggerKind: row.trigger_kind,
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
        },
      );
      // After the commit, and never able to fail it: a claimed job is already running under its lease.
      for (const refusal of refusals)
        notify("claim_refusal_log_failed", () => options.onRefused?.(refusal));
      for (const workspaceId of ignoredCostLimits)
        notify("ignored_cost_limit_callback_failed", () =>
          options.onIgnoredCostLimit?.(workspaceId),
        );
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
      return inAlertingTransaction<HeartbeatResult>(
        async (trx, unknownCost, endedClaims) => {
          const current = now();
          const timestamp = formatTimestamp(current);
          // The hard limit does not depend on anyone else's claim: the holder that is past it learns
          // so here, and the job fails.
          const timedOut = await failTimedOut(
            trx,
            { claim: { jobId, leaseToken } },
            current,
          );
          if (timedOut > 0) {
            endedClaims.push(jobId);
            unknownCost.push(
              ...(await closeRecordsOfEndedJobs(trx, timestamp)),
            );
          }
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
          if (row !== undefined) return { status: "ok", job: toJob(row) };
          // #397: a run a newer push replaced keeps its claim for the drain window, so its holder can finish the
          // requests in flight and report. It is told so; the lease is not extended.
          const superseded = await trx
            .selectFrom("jobs")
            .selectAll()
            .where("id", "=", jobId)
            .where("lease_token", "=", leaseToken)
            .where("status", "=", "superseded")
            .where("claimed_at", "is not", null)
            .where("result", "is", null)
            .where("lease_expires_at", ">", timestamp)
            .executeTakeFirst();
          return superseded === undefined
            ? { status: "not_holder" }
            : { status: "superseded", job: toJob(superseded) };
        },
      );
    },

    async noteSupersede(jobId, leaseToken) {
      const row = await db
        .updateTable("jobs")
        .set({ accepts_supersede: 1 })
        .where(runningWhere({ claim: { jobId, leaseToken } }))
        .returning("id")
        .executeTakeFirst();
      return row !== undefined;
    },

    complete(jobId, leaseToken, outcome) {
      const target: JobStatus = outcome.ok ? "succeeded" : "failed";
      const errorCode = outcome.ok ? null : outcome.errorCode;
      const result = outcome.result ?? null;
      return inAlertingTransaction<CompleteResult>(
        async (trx, unknownCost, endedClaims) => {
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
            endedClaims.push(jobId);
            // Settled from what the runner reported, in the same transaction as the job's end.
            const settlement = settlementOfOutcome(outcome);
            const settled = await createUsageRecordsRepository(
              trx,
              finished.workspace_id,
              now,
            ).settle(finished.id, settlement);
            // #361: no cost limit bounds a run without a cost; it is reported so it can be watched (once: when this
            // call settled the record, not when it was settled already).
            if (
              settled &&
              settlement.state === "settled" &&
              settlement.costMicroUsd === null
            )
              unknownCost.push({
                workspaceId: finished.workspace_id,
                jobId: finished.id,
              });
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
          if (job.status === "superseded") {
            // #397: the report of a run a newer push replaced is stored once and settles its record (the cost it
            // measured is usage, the run is not counted as a run of the quota). The job stays `superseded`. Another
            // report, after the first, is judged by the same rule as for any job.
            if (row.claimed_at === null) return { status: "not_holder" };
            if (row.result !== null)
              return isDeepStrictEqual(job.result, result)
                ? { status: "already_completed", job }
                : { status: "outcome_conflict", job };
            const timestamp = formatTimestamp(now());
            // The claim lasts the drain window and the report is taken for a grace after it, the time before which
            // the sweep does not settle the record (`closeRecordsOfEndedJobs`). Later the record is (or may be)
            // settled with an unknown cost already, and a record is settled once: the report is refused, like a
            // heartbeat, instead of being stored with a cost that is not applied.
            if (
              row.lease_expires_at === null ||
              Date.parse(row.lease_expires_at) + SUPERSEDED_REPORT_GRACE_MS <=
                now().getTime()
            )
              return { status: "not_holder" };
            const stored = await trx
              .updateTable("jobs")
              .set({
                result: result === null ? null : encodeJson(result),
                updated_at: timestamp,
              })
              .where("id", "=", jobId)
              .where("lease_token", "=", leaseToken)
              .where("status", "=", "superseded")
              .where("result", "is", null)
              .returningAll()
              .executeTakeFirst();
            if (stored === undefined) return { status: "not_holder" };
            const settlement = settlementOfSupersededOutcome(outcome);
            const settled = await createUsageRecordsRepository(
              trx,
              stored.workspace_id,
              now,
            ).settle(stored.id, settlement);
            if (
              settled &&
              settlement.state === "settled" &&
              settlement.costMicroUsd === null
            )
              unknownCost.push({
                workspaceId: stored.workspace_id,
                jobId: stored.id,
              });
            endedClaims.push(jobId);
            return { status: "completed", job: toJob(stored) };
          }
          if (job.status !== "succeeded" && job.status !== "failed")
            return { status: "not_holder" };
          const sameOutcome =
            job.status === target &&
            job.errorCode === errorCode &&
            isDeepStrictEqual(job.result, result);
          return sameOutcome
            ? { status: "already_completed", job }
            : { status: "outcome_conflict", job };
        },
      );
    },

    release(jobId, leaseToken, reason, releaseOptions = {}) {
      return inAlertingTransaction<ReleaseResult>(
        async (trx, unknownCost, endedClaims) => {
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
            endedClaims.push(jobId);
            unknownCost.push(
              ...(await closeRecordsOfEndedJobs(trx, timestamp)),
            );
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
          if (lost.failed > 0) endedClaims.push(jobId);
          unknownCost.push(...(await closeRecordsOfEndedJobs(trx, timestamp)));
          const row = await trx
            .selectFrom("jobs")
            .selectAll()
            .where("id", "=", jobId)
            .executeTakeFirstOrThrow();
          return lost.failed > 0
            ? { status: "failed", job: toJob(row) }
            : { status: "requeued", job: toJob(row) };
        },
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

    expireStaleJobs() {
      return inAlertingTransaction((trx, unknownCost, endedClaims) =>
        expire(trx, now(), unknownCost, endedClaims),
      );
    },

    failUndispatched(waitedMs) {
      return inAlertingTransaction((trx, unknownCost) =>
        failUndispatched(trx, now(), waitedMs, unknownCost),
      );
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
      return inAlertingTransaction<CancelClaimedResult>(
        async (trx, unknownCost, endedClaims) => {
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
          endedClaims.push(jobId);
          unknownCost.push(...(await closeRecordsOfEndedJobs(trx, timestamp)));
          return { status: "cancelled", job: toJob(row) };
        },
      );
    },
  };
}
