// SPDX-License-Identifier: Apache-2.0

// What the app does the moment a job ends or is given back (#395), so that the normal flow never waits for the
// cron sweep:
//
// - a slot freed (a job finished, failed or was given back): the queued jobs that the Dispatcher turned away
//   with "not now" (the pool cap, the running job of their pull request) are sent, the job of the pull request
//   that just ended first, and no more than there are free slots. Without `RUNNER_DISPATCH_MAX_RUNNING` the app does
//   not know the cap, and a freed slot is one job.
// - a job that was given back after a launch that failed (queued again) is sent again at once.
//
// It runs after the response of the call that ended the job (`after()`), never delays or fails it, and never throws.
import type { DispatchService } from "./service.ts";
import { DEFAULT_SEND_LIMIT } from "./service.ts";

/** A job that just ended or went back to the queue. */
export type JobEndedEvent = {
  jobId: string;
  repositoryId: string;
  prNumber: number;
  /** True when the job waits in the queue again (a failed launch given back), false when it is over. */
  requeued: boolean;
};

export type JobEndedReaction = (event: JobEndedEvent) => Promise<void>;

export type JobEndedDependencies = {
  dispatch: Pick<DispatchService, "sendWaiting" | "redispatch">;
  /** How many jobs run now, whoever claimed them. */
  countRunning: () => Promise<number>;
  /** The pool cap, or null when this side does not know it (`RUNNER_DISPATCH_MAX_RUNNING`). */
  maxRunning: () => number | null;
  log?: Pick<Console, "error">;
};

export function createJobEndedReaction(
  deps: JobEndedDependencies,
): JobEndedReaction {
  const log = deps.log ?? console;
  return async (event) => {
    try {
      if (event.requeued) await deps.dispatch.redispatch(event.jobId);
      const cap = deps.maxRunning();
      const free =
        cap === null
          ? 1
          : Math.min(DEFAULT_SEND_LIMIT, cap - (await deps.countRunning()));
      await deps.dispatch.sendWaiting({
        limit: free,
        first: { repositoryId: event.repositoryId, prNumber: event.prNumber },
      });
    } catch {
      // Nothing a database or a Dispatcher said is logged: a connection string can be in it.
      log.error("[dispatch] JOB_ENDED_DISPATCH_FAILED");
    }
  };
}
