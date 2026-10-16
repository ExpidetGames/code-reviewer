// SPDX-License-Identifier: Apache-2.0

// The dispatch webhook as a service (#326): wakes the Dispatcher for a job that was queued, and keeps the
// state of that call in `job_dispatches` so a call that failed is made again.
//
// - `onEnqueued(result)` is the hook of `createJobQueue`: it runs after the enqueue transaction committed
//   (in `after()` in the app, src/dispatch/shared.ts), never throws and never delays the enqueue.
// - `sendDue(limit)` is the hook of the cron sweep (#328): it sends every queued job that is due and has no
//   call yet, or whose call is due again (back-off over, acknowledgement timeout over, a job given back).
//   Nothing here schedules itself: no timer, no loop. A serverless instance lives for seconds.
// - `sendWaiting(...)` and `redispatch(jobId)` (#395) are what runs when a job ends: the jobs that were told "not
//   now" (the pool cap, the running job of their pull request) are sent as soon as a slot frees, and a job that was
//   given back after a failed launch is sent again at once. The normal flow never waits for the sweep.
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
  type PullRequestRef,
} from "../db/repositories/job-dispatches-repository.ts";
import type { Database } from "../db/schema.ts";
import type { EnqueueResult } from "../jobs/job-types.ts";
import type { WebhookDispatchConfig } from "./config.ts";
import {
  decideOutcome,
  type DispatchResultCode,
  type DispatchUpdate,
} from "./outcome.ts";
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
/**
 * #395: a call that failed with a transient answer is made again inside the request that queued the job, after
 * these pauses (at most three more calls), so a hiccup of the Dispatcher does not wait for the sweep.
 */
export const INLINE_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000];
/** The longest a request spends on inline retries, pauses and calls together (the function lives 60 seconds). */
export const INLINE_RETRY_BUDGET_MS = 35_000;
/** A `Retry-After` longer than this is not waited for inline; the row keeps it for the next sender. */
export const INLINE_RETRY_MAX_WAIT_MS = 10_000;
/**
 * How long a job that was given back may wait for its retry time inside the request that gave it back: the
 * Dispatcher gives a job back with 30 seconds, so that it does not start again in a hot loop (#395).
 */
export const REDISPATCH_MAX_WAIT_MS = 35_000;
/** The answers worth another try at once. A refusal (`rejected`) needs an operator and is never repeated inline. */
const TRANSIENT_CODES: readonly DispatchResultCode[] = [
  "rate_limited",
  "unavailable",
  "server_error",
  "timeout",
  "network_error",
];

export type DispatchLog = {
  /** A send that failed and will be made again. */
  warn(line: string): void;
  /** An answer an operator has to look at, or a dispatch that could not even be recorded. */
  error(line: string): void;
};

export type DispatchService = {
  /** The hook of the job queue. Never rejects. */
  onEnqueued(result: EnqueueResult): Promise<void>;
  /**
   * The hook of the sweep: sends what is due. Never rejects. With `minAgeMs` (#395) a job that changed less than that
   * long ago is left to the request that queued it (the repair work of the other requests asks for it).
   */
  sendDue(
    limit?: number,
    options?: { minAgeMs?: number },
  ): Promise<{ sent: number }>;
  /**
   * One job of `listDue`, as `sendDue` sends it. False when it sent nothing: another sender holds the job or
   * already dealt with it since the listing was made. Never rejects.
   */
  sendJob(job: DueDispatchJob): Promise<boolean>;
  /**
   * #395: a slot freed (a job ended). Sends up to `limit` queued jobs that were told "not now" (the pool cap, the
   * running job of their pull request, a busy Dispatcher), the job of `first` before the others, whatever time their
   * row says. Never rejects.
   */
  sendWaiting(options: {
    limit: number;
    first?: PullRequestRef;
  }): Promise<{ sent: number }>;
  /**
   * #395: a job was given back to the queue after a launch that failed: its dispatch is due again now and is sent
   * (a retry time of the job that is a few seconds away is waited for). Never rejects.
   */
  redispatch(jobId: string): Promise<void>;
};

type JobToSend = DueDispatchJob;

export function createDispatchService(options: {
  db: Kysely<Database>;
  config: WebhookDispatchConfig;
  fetch?: DispatchFetch;
  now?: () => Date;
  newId?: () => string;
  timeoutMs?: number;
  log?: DispatchLog;
  /** The pauses of the inline retries (#395); `[]` makes none. Default: `INLINE_RETRY_DELAYS_MS`. */
  inlineRetryDelaysMs?: readonly number[];
  /** Waits (default: a timer); tests pass a fake that moves their clock. */
  sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock in milliseconds, for the budget of the inline retries. */
  monotonicMs?: () => number;
}): DispatchService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DISPATCH_TIMEOUT_MS;
  const retryDelays = options.inlineRetryDelaysMs ?? INLINE_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const monotonicMs = options.monotonicMs ?? (() => performance.now());
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

  /** Claims the send and makes it. False when another sender holds the job; else what the answer came to. */
  async function claimAndSend(
    job: JobToSend,
    row: DispatchRow,
  ): Promise<DispatchUpdate | false> {
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
    return update;
  }

  /**
   * #395: after a call that failed with a transient answer, makes it again a few times with short pauses, within
   * the budget of the request. Returns as soon as the job is acknowledged, the answer is not transient, the budget
   * is used up or another sender took the job.
   */
  async function retryInline(
    job: JobToSend,
    first: DispatchUpdate,
    began: number,
  ): Promise<void> {
    let update = first;
    for (const delay of retryDelays) {
      if (!TRANSIENT_CODES.includes(update.lastCode)) return;
      // What the Dispatcher asked to wait wins over our pause, but only a short wait is spent inside the request.
      const pause = Math.max(delay, update.retryAfterMs ?? 0);
      if (pause > INLINE_RETRY_MAX_WAIT_MS) return;
      if (monotonicMs() - began + pause + timeoutMs > INLINE_RETRY_BUDGET_MS)
        return;
      await sleep(pause);
      // The job may have been taken (or ended) in the meantime; the call is repeated only for a queued job.
      if ((await dispatches.dueJob(job.jobId, now())) === undefined) return;
      const row = await dispatches.get(job.jobId);
      if (row === undefined || row.state !== "pending") return;
      const next = await claimAndSend(job, row);
      if (next === false) return;
      update = next;
    }
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

  async function sendOne(
    job: JobToSend,
    {
      waiting = false,
      retryFrom,
    }: {
      waiting?: boolean;
      /** Repeat a transient failure inline, within the budget that started at this `monotonicMs()` (#395). */
      retryFrom?: number;
    } = {},
  ): Promise<boolean> {
    return guarded(job.jobId, false, async () => {
      let row = await dispatches.get(job.jobId);
      if (row === undefined) {
        // A queued job without a row: the hook never ran or lost its write. Due now.
        if (!(await dispatches.create(job.jobId, now()))) return false;
        row = await dispatches.get(job.jobId);
        if (row === undefined) return false;
      }
      // The listing this job came from may be older than the row: a sender that claimed it since (a lease
      // in the future) or recorded its answer (the next look in the future) has the job, whatever the
      // listing said. Only a row that is due now is ours to claim.
      // A job that was told "not now" (#395) is sent when a slot frees, whatever time its row says.
      if (
        row.state === "stopped" ||
        (!waiting && Date.parse(row.nextDispatchAt) > now().getTime())
      )
        return false;
      const update = await claimAndSend(job, row);
      if (update === false) return false;
      // A Dispatcher that is still busy with the launch that just failed answers `429`: ask again in a moment.
      if (retryFrom !== undefined) await retryInline(job, update, retryFrom);
      return true;
    });
  }

  /** Sends the jobs of a listing, a few at a time; how many were sent. */
  async function sendAll(
    jobs: DueDispatchJob[],
    sendEach: (job: DueDispatchJob) => Promise<boolean>,
  ): Promise<number> {
    let sent = 0;
    const queue = [...jobs];
    await Promise.all(
      Array.from(
        { length: Math.min(SEND_CONCURRENCY, queue.length) },
        async () => {
          for (let job = queue.shift(); job !== undefined; job = queue.shift())
            if (await sendEach(job)) sent += 1;
        },
      ),
    );
    return sent;
  }

  return {
    async onEnqueued(result) {
      // A job that is returned because it exists already needs nothing, except the one a person pulled
      // forward (`already_active`): it was waiting behind a retry time and is due now.
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
        // Sent (or being sent) already: later calls are the next sender's. A job that is not due waits for it.
        if (row === undefined || row.attempts > 0 || row.state !== "pending")
          return;
        if (!due) return;
        const began = monotonicMs();
        const toSend = {
          jobId: job.id,
          reviewKind: job.reviewKind,
          jobAttempts: job.attempts,
        };
        const update = await claimAndSend(toSend, row);
        if (update !== false) await retryInline(toSend, update, began);
      });
    },

    sendJob: (job) => sendOne(job),

    async sendWaiting({ limit, first }) {
      if (limit <= 0) return { sent: 0 };
      let waiting: DueDispatchJob[];
      try {
        waiting = await dispatches.listWaiting(now(), limit, first);
      } catch (error) {
        log.error(
          `[dispatch] DISPATCH_FAILED job=none${errorCode(error) === undefined ? "" : ` code=${String(errorCode(error))}`}`,
        );
        return { sent: 0 };
      }
      return {
        sent: await sendAll(waiting, (job) => sendOne(job, { waiting: true })),
      };
    },

    async redispatch(jobId) {
      await guarded(jobId, undefined, async () => {
        const began = monotonicMs();
        const at = now();
        const runAfter = await dispatches.resetForResend(jobId, at);
        if (runAfter === undefined) return;
        // The retry time of the job (the Dispatcher gives a job back with 30 seconds) is waited for inside this
        // request; a longer one is the next sender's.
        const wait = runAfter.getTime() - at.getTime();
        if (wait > REDISPATCH_MAX_WAIT_MS) return;
        if (wait > 0) await sleep(wait);
        const job = await dispatches.dueJob(jobId, now());
        if (job !== undefined) await sendOne(job, { retryFrom: began });
      });
    },

    async sendDue(limit = DEFAULT_SEND_LIMIT, { minAgeMs = 0 } = {}) {
      let due: DueDispatchJob[];
      try {
        due = await dispatches.listDue(now(), limit, minAgeMs);
      } catch (error) {
        log.error(
          `[dispatch] DISPATCH_FAILED job=none${errorCode(error) === undefined ? "" : ` code=${String(errorCode(error))}`}`,
        );
        return { sent: 0 };
      }
      return { sent: await sendAll(due, (job) => sendOne(job)) };
    },
  };
}
