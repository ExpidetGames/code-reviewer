// SPDX-License-Identifier: Apache-2.0

// The queues of the running server, on the connection opened at start. Per request code (the webhook
// route, the runner API, the pages) asks for them here; tests build their own with `createJobQueue`
// and `createRunnerQueue`.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { inCurrentWorkspace } from "../workspaces/in-current-workspace.ts";
import { createJobQueue, type JobQueue } from "./job-queue.ts";
import { createRunnerQueue, type RunnerQueue } from "./runner-queue.ts";

/** The queue of one workspace. */
export function jobQueueFor(workspaceId: string): JobQueue {
  return createJobQueue(getDatabase(), workspaceId);
}

/** The queue of the workspace the signed-in user works in. */
export function getJobQueue(): JobQueue {
  return inCurrentWorkspace(jobQueueFor);
}

/** The queue as runners use it: one for the whole instance, every workspace. */
export function getRunnerQueue(): RunnerQueue {
  return createRunnerQueue(getDatabase());
}
