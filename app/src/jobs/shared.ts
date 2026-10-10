// The queue of the running server, on the connection opened at start. Per request code (the webhook
// route, the runner API) asks for it here; tests build their own with `createJobQueue`.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { createJobQueue, type JobQueue } from "./job-queue.ts";

export function getJobQueue(): JobQueue {
  return createJobQueue(getDatabase());
}
