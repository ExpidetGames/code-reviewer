// SPDX-License-Identifier: Apache-2.0

// Makes the queues of the running server tell the check run reconciler about every change of a job (#405), after
// the change was made: the way GitHub follows a job without a single caller having to know about it. The runner side
// (claim, result, release, cancel, a heartbeat that learns of a supersede or an end) names the job; what the queue
// does in bulk (jobs ended or requeued by an expired lease, a give-up, waiting jobs dropped by a closed pull request
// or a switched-off project) only asks for a reconcile, which finds them. A call is never changed or delayed by it: the
// notifier hands the work to `after()` and a notifier that throws is ignored.
import type { JobQueue } from "../jobs/job-queue.ts";
import type { EnqueueResult } from "../jobs/job-types.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";

export type CheckNotifier = {
  /** This job changed: make GitHub match it. */
  job(jobId: string): void;
  /** Some jobs changed that the caller cannot name: look for them. */
  change(): void;
};

/** Never lets a notifier break the call it follows. */
function safely(work: () => void): void {
  try {
    work();
  } catch {
    // The job is as the queue made it; the reconciler finds it anyway.
  }
}

export function notifyingRunnerQueue(
  queue: RunnerQueue,
  notify: CheckNotifier,
): RunnerQueue {
  return {
    ...queue,
    async claimNext(runnerId, engines, claimOptions) {
      const claimed = await queue.claimNext(runnerId, engines, claimOptions);
      if (claimed !== null) safely(() => notify.job(claimed.job.id));
      return claimed;
    },
    async heartbeat(jobId, leaseToken) {
      const result = await queue.heartbeat(jobId, leaseToken);
      // A superseded run's claim, and a job past the hard limit (this very call fails it), have changed.
      if (result.status !== "ok") safely(() => notify.job(jobId));
      return result;
    },
    async complete(jobId, leaseToken, outcome) {
      const result = await queue.complete(jobId, leaseToken, outcome);
      if (result.status === "completed") safely(() => notify.job(jobId));
      return result;
    },
    async release(jobId, leaseToken, reason, options) {
      const result = await queue.release(jobId, leaseToken, reason, options);
      if (result.status !== "not_holder")
        safely(() => notify.job(result.job.id));
      return result;
    },
    async cancelClaimed(jobId, leaseToken, errorCode) {
      const result = await queue.cancelClaimed(jobId, leaseToken, errorCode);
      if (result.status === "cancelled") safely(() => notify.job(jobId));
      return result;
    },
    async expireStaleJobs() {
      const report = await queue.expireStaleJobs();
      if (
        report.requeued +
          report.leaseExpired +
          report.timedOut +
          report.noCapableRunner >
        0
      )
        safely(() => notify.change());
      return report;
    },
    async failUndispatched(waitedMs) {
      const failed = await queue.failUndispatched(waitedMs);
      if (failed > 0) safely(() => notify.change());
      return failed;
    },
  };
}

/**
 * The producer side. `onEnqueued` is the hook `createJobQueue` calls once an enqueue has committed: it names the new
 * job and the waiting (or draining) jobs the new one replaced. A job that existed already did not change.
 */
function onEnqueued(notify: CheckNotifier): (result: EnqueueResult) => void {
  return (result) => {
    if (result.status !== "created") return;
    safely(() => notify.job(result.job.id));
    for (const replaced of result.supersededJobIds)
      safely(() => notify.job(replaced));
  };
}

function afterDropped(
  drop: () => Promise<number>,
  notify: CheckNotifier,
): Promise<number> {
  return drop().then((count) => {
    if (count > 0) safely(() => notify.change());
    return count;
  });
}

function notifyingJobQueueFunction(
  queue: JobQueue,
  notify: CheckNotifier,
): JobQueue {
  return {
    ...queue,
    cancelWaitingForRepository: (repositoryId) =>
      afterDropped(
        () => queue.cancelWaitingForRepository(repositoryId),
        notify,
      ),
    cancelWaitingForReviewKindChange: (repositoryId) =>
      afterDropped(
        () => queue.cancelWaitingForReviewKindChange(repositoryId),
        notify,
      ),
    discardWaitingForPr: (repositoryId, prNumber) =>
      afterDropped(
        () => queue.discardWaitingForPr(repositoryId, prNumber),
        notify,
      ),
    discardWaitingAutomaticForPr: (repositoryId, prNumber) =>
      afterDropped(
        () => queue.discardWaitingAutomaticForPr(repositoryId, prNumber),
        notify,
      ),
  };
}

export const notifyingJobQueue = Object.assign(notifyingJobQueueFunction, {
  onEnqueued,
});
