// SPDX-License-Identifier: Apache-2.0

// The check run and the review verdict of a review job (#405, README.md in this folder). The App, not the Worker,
// makes GitHub match the job: it holds the installation token and sees every way a job ends (a result, a release, a
// supersede, a lease that ran out, the sweep). `syncJob` reads the job and does whatever is still missing, so it is
// safe to call from any of those places and to repeat:
//
//  - the check run of the job (one per job and head commit, named "Code Reviewer") shows the status of the job:
//    waiting, reviewing, and a conclusion that is never red (check-text.ts). It is made once and changed in place
//    by its stored id; one that was made but whose id was not kept (the process died) is found again by the id of
//    the job (`external_id`) before another is made.
//  - after a successful review the verdict is submitted once (verdict.ts), by the stored review id and, after an
//    attempt that may have worked, by looking for the App's own review with the job's marker first. It is submitted
//    only while the pull request is open and still at the head that was reviewed.
//
// Best effort throughout. Nothing here throws or changes a job: a failure is one log line with a stable code and ids
// only (never a token, a body or a name), retried a few times after a back-off (`reconcileDue`, called by the sweep,
// the timer of a long-lived server and the requests that touch the database). An App that was not granted the Checks
// permission (an installation that has not accepted it, an App made by hand) simply has no check run: the row's
// check part is dropped with `CHECK_RUN_PERMISSION_MISSING`, once per job, and the verdict, which needs another
// permission, goes on.
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type {
  JobCheckRunsRepository,
  StoredJobCheck,
} from "../db/repositories/job-check-runs-repository.ts";
import type { JobWithCheckWork } from "../db/repositories/job-check-runs-sweep.ts";
import type {
  RepositoriesRepository,
  StoredRepository,
} from "../db/repositories/repositories-repository.ts";
import { IntegrationError } from "../integrations/errors.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import type { Job } from "../jobs/job-types.ts";
import type { ReviewVerdictMode } from "../review-settings/settings.ts";
import { describeCheck } from "./check-text.ts";
import { readResultFacts } from "./result-facts.ts";
import { decideVerdict, verdictBody, verdictMarker } from "./verdict.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The name of the check run in the checks area of the pull request. */
export const CHECK_NAME = "Code Reviewer";
/** How long one sync holds the job: another instance does not sync it meanwhile. Under the 60 s of a function. */
export const SYNC_LEASE_MS = 90 * SECOND;
/** After a failed sync the job waits this long times the failures so far. */
export const RETRY_WAIT_MS = 2 * MINUTE;
/** A job whose syncs failed this many times in a row is given up. */
export const MAX_ATTEMPTS = 5;
/** A sync of a job that changed while it ran goes round again, at most this often. */
const MAX_ROUNDS = 3;
/** How many jobs one `reconcileDue` works through, and for how long at most (a function lives 60 seconds). */
export const RECONCILE_BATCH = 20;
export const RECONCILE_BUDGET_MS = 40 * SECOND;
/** The longest a rate limit is waited for. */
const MAX_RETRY_AFTER_MS = 60 * MINUTE;

/** The stable codes of the log lines and of what the row keeps. */
export const CHECK_RUN_LOG_CODES = [
  "CHECK_RUN_PERMISSION_MISSING",
  "CHECK_RUN_FAILED",
  "CHECK_RUN_UNSUPPORTED",
  "CHECK_RUN_CONNECTION_UNAVAILABLE",
  "CHECK_RUN_ERROR",
  "REVIEW_VERDICT_SUBMITTED",
  "REVIEW_VERDICT_SKIPPED",
  "REVIEW_VERDICT_REFUSED",
] as const;

export type CheckRunServiceDeps = {
  /** A job by its id, whatever its workspace (the runner queue's `get`). */
  jobs: { get(id: string): Promise<Job | undefined> };
  repositories: (workspaceId: string) => Pick<RepositoriesRepository, "get">;
  integrations: (workspaceId: string) => Pick<IntegrationsRepository, "get">;
  checks: (workspaceId: string) => JobCheckRunsRepository;
  /** The jobs whose check run is behind, across workspaces (the reconciler). */
  dueJobs: (
    now: Date,
    options: { limit: number },
  ) => Promise<JobWithCheckWork[]>;
  /** What the project of the repository wants submitted after a review (read when it is decided). */
  verdictMode: (
    workspaceId: string,
    repositoryId: string,
  ) => Promise<ReviewVerdictMode>;
  registry: Pick<IntegrationRegistry, "resolve">;
  now: () => Date;
  /** Receives lines of ids and stable codes only. */
  log: { info(line: string): void; error(line: string): void };
};

export type ReconcileReport = { synced: number };

export type CheckRunService = {
  /** Never rejects. Makes GitHub show what the job is now, and submits the verdict of a successful review. */
  syncJob(jobId: string): Promise<void>;
  /** Never rejects. Syncs the jobs whose check run is behind or whose retry is due: at most a batch, within a budget. */
  reconcileDue(): Promise<ReconcileReport>;
};

function errorCodeOf(error: unknown): string {
  return error instanceof IntegrationError
    ? error.code
    : "INTEGRATION_ACCESS_FAILED";
}

function repoRefOf(repository: StoredRepository): RepoRef {
  return {
    integrationId: repository.integrationId,
    externalId: repository.externalId,
    fullName: repository.fullName,
    url: repository.url,
  };
}

const FINAL_STATUSES: readonly string[] = [
  "succeeded",
  "failed",
  "superseded",
  "cancelled",
];

type Target = {
  job: Job;
  integration: Integration;
  provider: IntegrationProvider;
  repo: RepoRef;
};

export function createCheckRunService(
  deps: CheckRunServiceDeps,
): CheckRunService {
  // One reconcile at a time inside a process: a backlog never opens many requests at GitHub at once.
  let tail: Promise<unknown> = Promise.resolve();
  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  const where = (job: Job) =>
    `job=${job.id} workspace=${job.workspaceId} repository=${job.repositoryId}`;

  /** What the job's connection can do, or null (and the row is dropped) when nothing can be done for it. */
  async function targetOf(
    job: Job,
    checks: JobCheckRunsRepository,
  ): Promise<Target | null> {
    const repository = await deps
      .repositories(job.workspaceId)
      .get(job.repositoryId);
    const integration =
      repository === undefined
        ? undefined
        : await deps
            .integrations(job.workspaceId)
            .get(repository.integrationId);
    if (
      repository === undefined ||
      integration === undefined ||
      integration.status !== "active"
    ) {
      deps.log.error(
        `[check-runs] CHECK_RUN_CONNECTION_UNAVAILABLE ${where(job)}`,
      );
      await checks.drop(job.id, "CHECK_RUN_CONNECTION_UNAVAILABLE");
      return null;
    }
    const provider = deps.registry.resolve(integration.type);
    if (provider.publishReviewCheck === undefined) {
      deps.log.error(`[check-runs] CHECK_RUN_UNSUPPORTED ${where(job)}`);
      await checks.drop(job.id, "CHECK_RUN_UNSUPPORTED");
      return null;
    }
    return { job, integration, provider, repo: repoRefOf(repository) };
  }

  /** The check run of the job shows the status the job has. */
  async function syncCheck(
    target: Target,
    held: StoredJobCheck,
    checks: JobCheckRunsRepository,
  ): Promise<void> {
    const { job, integration, provider, repo } = target;
    if (held.checkState === "dropped" || held.syncedStatus === job.status)
      return;
    // A job that was cancelled or replaced before it ever showed anything has nothing to show now.
    if (
      held.checkRunId === null &&
      (job.status === "cancelled" || job.status === "superseded")
    )
      return;
    const facts = readResultFacts(job.result);
    const text = describeCheck({
      status: job.status,
      errorCode: job.errorCode,
      commentUrl: facts.commentUrl,
      findings: facts.findings,
      stoppedEarly: facts.stoppedEarly,
    });
    if (held.checkRunId === null) await checks.noteStarted(job.id, "check");
    try {
      const published = await provider.publishReviewCheck?.(
        integration,
        repo,
        {
          jobId: job.id,
          headSha: job.headSha,
          name: CHECK_NAME,
          ...text,
        },
        {
          checkRunId: held.checkRunId,
          // An earlier attempt to make it may have worked without its id being kept.
          mayExist: held.checkRunId === null && held.checkCreateAttempts > 0,
        },
      );
      if (published === undefined) return;
      await checks.recordCheck(job.id, {
        checkRunId: published.checkRunId,
        syncedStatus: job.status,
      });
    } catch (error) {
      if (
        !(error instanceof IntegrationError) ||
        error.code !== "INTEGRATION_ACCESS_SCOPE_REFUSED"
      )
        throw error;
      // The App may not write check runs (the installation has not accepted the permission, an App made by hand
      // lacks it): once per job, and the job goes on without one. The verdict needs another permission.
      deps.log.error(`[check-runs] CHECK_RUN_PERMISSION_MISSING ${where(job)}`);
      await checks.dropCheck(job.id, "CHECK_RUN_PERMISSION_MISSING");
    }
  }

  async function skipVerdict(
    job: Job,
    checks: JobCheckRunsRepository,
    reason: string,
  ): Promise<void> {
    deps.log.info(
      `[check-runs] REVIEW_VERDICT_SKIPPED ${where(job)} reason=${reason}`,
    );
    await checks.recordReview(job.id, { reviewId: null, reviewState: "done" });
  }

  /** After a successful review: decide the verdict, and submit it once if there is one. */
  async function syncVerdict(
    target: Target,
    held: StoredJobCheck,
    checks: JobCheckRunsRepository,
  ): Promise<void> {
    const { job, integration, provider, repo } = target;
    if (job.status !== "succeeded" || held.reviewState !== "pending") return;
    const mode = await deps.verdictMode(job.workspaceId, job.repositoryId);
    const facts = readResultFacts(job.result);
    const decision = decideVerdict({
      mode,
      findings: facts.findings,
      stoppedEarly: facts.stoppedEarly,
    });
    if (decision.kind === "skip")
      return skipVerdict(job, checks, decision.reason);
    if (provider.submitReviewVerdict === undefined)
      return skipVerdict(job, checks, "unsupported");

    // Only a pull request that is open and still at the head that was reviewed gets a verdict: the review of a
    // newer head decides for itself, and a verdict on an old head would be read as one on the new.
    let pullRequest;
    try {
      pullRequest = await provider.getPullRequest(
        integration,
        repo,
        job.prNumber,
      );
    } catch (error) {
      if (
        error instanceof IntegrationError &&
        error.code === "INTEGRATION_PULL_REQUEST_NOT_FOUND"
      )
        return skipVerdict(job, checks, "pull_request_gone");
      throw error;
    }
    if (pullRequest.state !== "open")
      return skipVerdict(job, checks, "pull_request_closed");
    if (pullRequest.headSha !== job.headSha)
      return skipVerdict(job, checks, "stale_head");

    await checks.noteStarted(job.id, "review");
    try {
      const submitted = await provider.submitReviewVerdict(
        integration,
        repo,
        job.prNumber,
        {
          jobId: job.id,
          headSha: job.headSha,
          event: decision.event,
          body: verdictBody({
            jobId: job.id,
            event: decision.event,
            mode,
            blocking: decision.blocking,
            commentUrl: facts.commentUrl,
          }),
          marker: verdictMarker(job.id),
        },
        // An earlier attempt may have submitted it without its id being kept: the App's own review is looked for.
        { lookForEarlier: held.reviewSubmitAttempts > 0 },
      );
      await checks.recordReview(job.id, {
        reviewId: submitted.reviewId,
        reviewState: "done",
      });
      deps.log.info(
        `[check-runs] REVIEW_VERDICT_SUBMITTED ${where(job)} event=${decision.event} outcome=${submitted.outcome}`,
      );
    } catch (error) {
      if (
        !(error instanceof IntegrationError) ||
        (error.code !== "INTEGRATION_ACCESS_SCOPE_REFUSED" &&
          error.code !== "INTEGRATION_REQUEST_REFUSED")
      )
        throw error;
      // GitHub refuses this review for good (the App may not review, or the pull request is its own): no retry.
      deps.log.error(
        `[check-runs] REVIEW_VERDICT_REFUSED ${where(job)} code=${error.code}`,
      );
      await checks.recordReview(job.id, {
        reviewId: null,
        reviewState: "dropped",
      });
    }
  }

  /** A failed sync waits and is tried again, a bounded number of times; a connection that is gone is given up. */
  async function failedSync(
    job: Job,
    held: StoredJobCheck,
    checks: JobCheckRunsRepository,
    error: unknown,
  ): Promise<void> {
    const code = errorCodeOf(error);
    if (code === "INTEGRATION_ACCESS_CONNECTION_GONE") {
      deps.log.error(
        `[check-runs] CHECK_RUN_FAILED ${where(job)} code=${code} gone`,
      );
      await checks.drop(job.id, code);
      return;
    }
    const wait =
      error instanceof IntegrationError && error.retryAfterSeconds !== null
        ? Math.min(error.retryAfterSeconds * SECOND, MAX_RETRY_AFTER_MS)
        : 0;
    const attempt = held.attempts + 1;
    deps.log.error(
      `[check-runs] CHECK_RUN_FAILED ${where(job)} code=${code} attempt=${String(attempt)}`,
    );
    await checks.failed(job.id, {
      code,
      retryAt: new Date(
        deps.now().getTime() + Math.max(wait, RETRY_WAIT_MS * attempt),
      ),
      maxAttempts: MAX_ATTEMPTS,
    });
  }

  /** One round: true when the job changed while it ran, so another round is due. */
  async function syncRound(jobId: string): Promise<boolean> {
    const job = await deps.jobs.get(jobId);
    if (job === undefined) return false;
    const checks = deps.checks(job.workspaceId);

    // Nothing to do (in step, settled, dropped): no write, no call.
    const known = await checks.find(job.id);
    if (known !== undefined && !needsWork(known, job)) return false;

    const taken = await checks.take(job.id, { leaseMs: SYNC_LEASE_MS });
    if (!taken.acquired) return false;
    const held = taken.check;
    try {
      const target = await targetOf(job, checks);
      if (target === null) return false;
      await syncCheck(target, held, checks);
      const afterCheck = (await checks.find(job.id)) ?? held;
      await syncVerdict(target, afterCheck, checks);
      const done = (await checks.find(job.id)) ?? afterCheck;
      const final = FINAL_STATUSES.includes(job.status);
      const checkDone =
        done.checkState === "dropped" ||
        done.syncedStatus === job.status ||
        (done.checkRunId === null &&
          (job.status === "cancelled" || job.status === "superseded"));
      const verdictDone =
        job.status !== "succeeded" || done.reviewState !== "pending";
      await checks.finish(job.id, {
        settled: final && checkDone && verdictDone,
      });
    } catch (error) {
      await failedSync(job, held, checks, error);
      return false;
    }
    const latest = await deps.jobs.get(job.id);
    return latest !== undefined && latest.status !== job.status;
  }

  async function syncJob(jobId: string): Promise<void> {
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1)
        if (!(await syncRound(jobId))) return;
    } catch (error) {
      deps.log.error(
        `[check-runs] CHECK_RUN_ERROR job=${jobId} code=${errorCodeOf(error)}`,
      );
    }
  }

  return {
    syncJob,

    reconcileDue() {
      return inOrder(async () => {
        const started = deps.now().getTime();
        let due: JobWithCheckWork[];
        try {
          due = await deps.dueJobs(deps.now(), { limit: RECONCILE_BATCH });
        } catch (error) {
          deps.log.error(
            `[check-runs] CHECK_RUN_ERROR code=${errorCodeOf(error)}`,
          );
          return { synced: 0 };
        }
        let synced = 0;
        for (const item of due) {
          // The function that runs this lives 60 seconds: what is left waits for the next run.
          if (deps.now().getTime() - started > RECONCILE_BUDGET_MS) break;
          await syncJob(item.jobId);
          synced += 1;
        }
        return { synced };
      });
    },
  };
}

/** Is there anything left to do for the job given the row? */
function needsWork(row: StoredJobCheck, job: Job): boolean {
  if (row.state !== "active") return false;
  const checkBehind =
    row.checkState === "active" && row.syncedStatus !== job.status;
  const verdictDue =
    job.status === "succeeded" && row.reviewState === "pending";
  // A job that ended with nothing left to send still has its row settled, in one pass that makes no call.
  return checkBehind || verdictDue || FINAL_STATUSES.includes(job.status);
}
