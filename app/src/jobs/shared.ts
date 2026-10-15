// SPDX-License-Identifier: Apache-2.0

// The queues of the running server, on the connection opened at start. Per request code (the webhook
// route, the runner API, the pages) asks for them here; tests build their own with `createJobQueue`
// and `createRunnerQueue`.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { dispatchHook } from "../dispatch/shared.ts";
import { createJobQueue, type JobQueue } from "./job-queue.ts";
import { configuredNoCapableRunnerMs } from "./job-limits.ts";
import { createRunnerQueue, type RunnerQueue } from "./runner-queue.ts";

/**
 * The queue of one workspace. Every producer (the GitHub webhook, a comment, the start button) gets its
 * queue here, so each of them wakes the Dispatcher after it queued a job when `RUNNER_DISPATCH=webhook`
 * (#326); by default there is no hook and nothing changes.
 */
export function jobQueueFor(workspaceId: string): JobQueue {
  const onEnqueued = dispatchHook();
  return createJobQueue(getDatabase(), workspaceId, {
    ...(onEnqueued === undefined ? {} : { onEnqueued }),
  });
}

/** The queue as runners use it: one for the whole instance, every workspace. */
export function getRunnerQueue(): RunnerQueue {
  return createRunnerQueue(getDatabase(), {
    // #195: how long a job no capable runner claims may wait; the operator owns the value.
    limits: { noCapableRunnerMs: configuredNoCapableRunnerMs(process.env) },
    // #277: a job refused for the entitlements of its workspace is failed inside the claim; this is its log line
    // (ids and codes only, never a name or a number of the plan).
    onRefused: ({ jobId, workspaceId, errorCode, detail }) =>
      console.info(
        `[queue] job=${jobId} workspace=${workspaceId} refused at claim: ${errorCode}${detail === undefined ? "" : ` (${detail})`}`,
      ),
  });
}
