// SPDX-License-Identifier: Apache-2.0

// The dispatch webhook as a service (#326): wakes the Dispatcher for a job that was queued, and keeps the
// state of that call in `job_dispatches` so a call that failed is made again.
//
// - `onEnqueued(result)` is the hook of `createJobQueue`: it runs after the enqueue transaction committed
//   (in `after()` in the app, src/dispatch/shared.ts), never throws and never delays the enqueue.
// - `sendDue(limit)` is the hook of the cron sweep (#328): it sends every queued job that is due and has no
//   call yet, or whose call is due again (back-off over, acknowledgement timeout over, a job given back).
//   Nothing here schedules itself: no timer, no loop. A serverless instance lives for seconds; the clock is
//   the sweep.
//
// A send is claimed in the row first (`claimSend`, a compare and set on `next_dispatch_at`), so the request
// that queued the job, the sweep and another instance never send the same call twice. The job itself is
// durable before any of this starts: nothing here can lose it.
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { errorCode } from "../db/errors.ts";
import {
  createJobDispatchesRepository,
  type DispatchRow,
  type DueDispatchJob,
} from "../db/repositories/job-dispatches-repository.ts";
import type { Database } from "../db/schema.ts";
import type { EnqueueResult } from "../jobs/job-types.ts";
import type { WebhookDispatchConfig } from "./config.ts";
import { decideOutcome, type DispatchUpdate } from "./outcome.ts";
import { buildDispatchRequest } from "./request.ts";
import {
  DISPATCH_TIMEOUT_MS,
  sendDispatch,
  type DispatchFetch,
} from "./send.ts";

/** How long a claimed send holds the row: the request limit plus time to store the answer. */
export const SEND_LEASE_MS = 30_000;
/** How many jobs one `sendDue` sends if not told otherwise, and how many requests it has in flight. */
export const DEFAULT_SEND_LIMIT = 20;
const SEND_CONCURRENCY = 5;

export type DispatchLog = {
  /** A send that failed and will be made again. */
  warn(line: string): void;
  /** An answer an operator has to look at, or a dispatch that could not even be recorded. */
  error(line: string): void;
};

export type DispatchService = {
  /** The hook of the job queue. Never rejects. */
  onEnqueued(result: EnqueueResult): Promise<void>;
  /** The hook of the sweep: sends what is due. Never rejects. */
  sendDue(limit?: number): Promise<{ sent: number }>;
};

type JobToSend = {
  jobId: string;
  reviewKind: "diff" | "dynamic";
  /** The job's lost attempts; the call carries the number of the attempt it is on. */
  jobAttempts: number;
};

export function createDispatchService(options: {
  db: Kysely<Database>;
  config: WebhookDispatchConfig;
  fetch?: DispatchFetch;
  now?: () => Date;
  newId?: () => string;
  timeoutMs?: number;
  log?: DispatchLog;
}): DispatchService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DISPATCH_TIMEOUT_MS;
  const log: DispatchLog = options.log ?? {
    warn: (line) => console.warn(line),
    error: (line) => console.error(line),
  };
  const { config } = options;
  const dispatches = createJobDispatchesRepository(options.db, now);

  /** Logs a failed send: the stable code and the numbers, nothing the answer or the error said. */
  function report(job: JobToSend, update: DispatchUpdate): void {
    if (update.lastCode === "accepted" || update.state === "stopped") return;
    const status =
      update.lastStatus === null ? "none" : String(update.lastStatus);
    if (update.alert) {
      log.error(
        `[dispatch] DISPATCH_REJECTED job=${job.jobId} code=${update.lastCode} status=${status} retry_at=${update.nextDispatchAt.toISOString()}: check RUNNER_WEBHOOK_URL and RUNNER_WEBHOOK_SECRET against the Dispatcher`,
      );
      return;
    }
    if (update.consecutiveFailures === 0) return;
    log.warn(
      `[dispatch] DISPATCH_SEND_FAILED job=${job.jobId} code=${update.lastCode} status=${status} failures=${String(update.consecutiveFailures)} retry_at=${update.nextDispatchAt.toISOString()}`,
    );
  }

  /** Claims the send and makes it. False when another sender holds the job. */
  async function claimAndSend(
    job: JobToSend,
    row: DispatchRow,
  ): Promise<boolean> {
    const claimed = await dispatches.claimSend(
      job.jobId,
      row.nextDispatchAt,
      new Date(now().getTime() + SEND_LEASE_MS),
    );
    if (!claimed) return false;

    const sentAt = now();
    const request = buildDispatchRequest({
      key: config.currentKey,
      ...(config.bypassToken === undefined
        ? {}
        : { bypassToken: config.bypassToken }),
      jobId: job.jobId,
      reviewKind: job.reviewKind,
      attempt: job.jobAttempts + 1,
      dispatchId: newId(),
      now: sentAt,
    });
    const result = await sendDispatch({
      url: config.url,
      request,
      fetch: send,
      timeoutMs,
      now,
    });
    const finished = now();
    const update = decideOutcome(result, row.consecutiveFailures, finished);
    await dispatches.record(job.jobId, update, finished);
    report(job, update);
    return true;
  }

  /** Never throws: whatever fails is logged by its stable code, never by its message. */
  async function guarded<T>(
    jobId: string,
    fallback: T,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      log.error(
        `[dispatch] DISPATCH_FAILED job=${jobId}${errorCode(error) === undefined ? "" : ` code=${String(errorCode(error))}`}`,
      );
      return fallback;
    }
  }

  async function sendOne(job: JobToSend): Promise<boolean> {
    return guarded(job.jobId, false, async () => {
      let row = await dispatches.get(job.jobId);
      if (row === undefined) {
        // A queued job without a row: the hook never ran or lost its write. Due now.
        if (!(await dispatches.create(job.jobId, now()))) return false;
        row = await dispatches.get(job.jobId);
        if (row === undefined) return false;
      }
      return claimAndSend(job, row);
    });
  }

  return {
    async onEnqueued(result) {
      // A job that is returned because it exists already needs nothing, except the one a person pulled
      // forward (`already_active`): it was waiting behind a debounce and is due now.
      if (result.status === "existing" && result.reason !== "already_active")
        return;
      const { job } = result;
      if (job.status !== "queued") return;
      await guarded(job.id, undefined, async () => {
        const at = now();
        const due = Date.parse(job.runAfter) <= at.getTime();
        let row = await dispatches.get(job.id);
        if (row === undefined) {
          const created = await dispatches.create(
            job.id,
            due ? at : new Date(job.runAfter),
          );
          if (!created) return;
          row = await dispatches.get(job.id);
        }
        // Sent (or being sent) already: later calls are the sweep's. A job that is not due waits for it.
        if (row === undefined || row.attempts > 0 || row.state !== "pending")
          return;
        if (!due) return;
        await claimAndSend(
          {
            jobId: job.id,
            reviewKind: job.reviewKind,
            jobAttempts: job.attempts,
          },
          row,
        );
      });
    },

    async sendDue(limit = DEFAULT_SEND_LIMIT) {
      let due: DueDispatchJob[];
      try {
        due = await dispatches.listDue(now(), limit);
      } catch (error) {
        log.error(
          `[dispatch] DISPATCH_FAILED job=none${errorCode(error) === undefined ? "" : ` code=${String(errorCode(error))}`}`,
        );
        return { sent: 0 };
      }
      let sent = 0;
      const queue = [...due];
      await Promise.all(
        Array.from(
          { length: Math.min(SEND_CONCURRENCY, queue.length) },
          async () => {
            for (
              let job = queue.shift();
              job !== undefined;
              job = queue.shift()
            )
              if (await sendOne(job)) sent += 1;
          },
        ),
      );
      return { sent };
    },
  };
}
