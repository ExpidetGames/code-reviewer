// SPDX-License-Identifier: Apache-2.0

// The stop call of the dispatch webhook (#487): when the claim of a job ends, the App tells the Dispatcher that sent the
// job's wake-up to stop the job's Sandbox VM. The Dispatcher holds no supervision after the hand-over and the VM never
// gets access to it, so this signed `POST /stop` is the whole of the way a VM is ended on purpose; the reaper cron of the
// Dispatcher and the VM's own timeout are the safety nets.
//
// - Best effort. The job's transition committed before this runs (`after()`, src/dispatch/shared.ts), and nothing here
//   throws or is awaited by it.
// - Only for a job whose wake-up a Dispatcher acknowledged (`job_dispatches.acked_at`). A self-hosted runner or a
//   Compose stack polls (`RUNNER_DISPATCH=poll`): no service exists and nothing is sent. The job's row is the proof
//   that a Dispatcher started it, so an instance that also has polling runners never signs a call for their jobs.
// - A bounded retry for a transient answer (`STOP_RETRY_DELAYS_MS`, 5 seconds a call); the same `stopId` in every
//   repeat, so a stop that arrived twice is a replay the receiver ignores. A failure is logged once per job with a
//   stable code (`STOP_RESULT_CODES`) and never with the URL, a key, a header or the text of an error.
// - A Dispatcher of the previous release has no `/stop` and answers 404: logged once as `DISPATCH_STOP_UNSUPPORTED`,
//   never repeated. The reaper then ends the VM as it did before.
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import type { Database } from "../db/schema.ts";
import type { WebhookDispatchConfig } from "./config.ts";
import { buildStopRequest } from "./request.ts";
import { parseRetryAfter, type DispatchFetch } from "./send.ts";

/** One call of the stop: shorter than the wake-up's 8 seconds, because the Dispatcher answers before it stops anything. */
export const STOP_TIMEOUT_MS = 5_000;
/** The pauses before the repeats of a transient failure: at most two more calls. */
export const STOP_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];
/** A longer `Retry-After` of the Dispatcher is cut to this: a stop is not worth a longer wait inside a request. */
const STOP_RETRY_AFTER_CAP_MS = 5_000;
/** How many jobs are stopped at once when a sweep ends many. */
const STOP_CONCURRENCY = 5;

export const STOP_RESULT_CODES = [
  "DISPATCH_STOP_FAILED",
  "DISPATCH_STOP_UNSUPPORTED",
  "DISPATCH_STOP_REJECTED",
  "DISPATCH_STOP_URL_INVALID",
] as const;
export type StopResultCode = (typeof STOP_RESULT_CODES)[number];

/**
 * The Dispatcher's `POST /stop` for the address of its `POST /dispatch` (they are one project): the last path segment
 * `dispatch` becomes `stop`. Null for an address that does not end in `/dispatch`; the stop is then not sent, and says so.
 */
export function stopUrlOf(dispatchUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(dispatchUrl);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/");
  if (segments[segments.length - 1] !== "dispatch") return null;
  segments[segments.length - 1] = "stop";
  url.pathname = segments.join("/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

type StopAnswer =
  | { kind: "done" }
  | { kind: "transient"; retryAfterMs: number | null }
  | { kind: "unsupported" }
  | { kind: "rejected"; status: number }
  | { kind: "unreachable" };

export type StopLog = {
  /** A stop that failed, with its stable code. One line per job. */
  warn(line: string): void;
};

export type StopService = {
  /** Stops the VMs of these jobs, best effort. Never rejects. */
  stopJobs(jobIds: readonly string[]): Promise<void>;
};

export function createStopService(options: {
  db: Kysely<Database>;
  config: WebhookDispatchConfig;
  fetch?: DispatchFetch;
  now?: () => Date;
  newId?: () => string;
  timeoutMs?: number;
  /** The pauses before the repeats; `[]` makes none. */
  retryDelaysMs?: readonly number[];
  /** Waits (default: a timer); tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
  log?: StopLog;
}): StopService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? STOP_TIMEOUT_MS;
  const retryDelays = options.retryDelaysMs ?? STOP_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log: StopLog = options.log ?? { warn: (line) => console.warn(line) };
  const { config } = options;
  const dispatches = createJobDispatchesRepository(options.db, now);
  const url = stopUrlOf(config.url);

  /** One call, whose answer is reduced to what decides the next step. The body of the answer is never read. */
  async function call(jobId: string, stopId: string): Promise<StopAnswer> {
    const sentAt = now();
    const request = buildStopRequest({
      key: config.currentKey,
      ...(config.bypassToken === undefined
        ? {}
        : { bypassToken: config.bypassToken }),
      jobId,
      stopId,
      now: sentAt,
    });
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await send(url as string, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        cache: "no-store",
        signal,
      });
      void response.body?.cancel().catch(() => undefined);
      const { status } = response;
      if (status === 200 || status === 202) return { kind: "done" };
      if (status === 404) return { kind: "unsupported" };
      if (status === 429 || status === 503) {
        const seconds = parseRetryAfter(
          response.headers.get("retry-after"),
          now(),
        );
        return {
          kind: "transient",
          retryAfterMs: seconds === null ? null : seconds * 1000,
        };
      }
      if (status >= 500) return { kind: "transient", retryAfterMs: null };
      return { kind: "rejected", status };
    } catch {
      return { kind: "unreachable" };
    }
  }

  function fail(jobId: string, code: StopResultCode, status?: number): void {
    log.warn(
      `[dispatch] ${code} job=${jobId}${status === undefined ? "" : ` status=${String(status)}`}`,
    );
  }

  async function stopOne(jobId: string): Promise<void> {
    const row = await dispatches.get(jobId);
    // No Dispatcher acknowledged this job: a self-hosted runner's job, or one that was never dispatched.
    if (row === undefined || row.ackedAt === null) return;
    if (url === null) return fail(jobId, "DISPATCH_STOP_URL_INVALID");
    const stopId = newId();
    let answer = await call(jobId, stopId);
    for (const delay of retryDelays) {
      if (answer.kind !== "transient" && answer.kind !== "unreachable") break;
      const asked = answer.kind === "transient" ? answer.retryAfterMs : null;
      await sleep(
        Math.max(delay, Math.min(asked ?? 0, STOP_RETRY_AFTER_CAP_MS)),
      );
      answer = await call(jobId, stopId);
    }
    switch (answer.kind) {
      case "done":
        return;
      case "unsupported":
        return fail(jobId, "DISPATCH_STOP_UNSUPPORTED", 404);
      case "rejected":
        return fail(jobId, "DISPATCH_STOP_REJECTED", answer.status);
      case "transient":
      case "unreachable":
        return fail(jobId, "DISPATCH_STOP_FAILED");
    }
  }

  return {
    async stopJobs(jobIds) {
      const queue = [...new Set(jobIds)];
      await Promise.all(
        Array.from(
          { length: Math.min(STOP_CONCURRENCY, queue.length) },
          async () => {
            for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
              try {
                await stopOne(id);
              } catch {
                // The database failed (the lookup of the row): the reaper ends the VM. Only the code, never the error.
                fail(id, "DISPATCH_STOP_FAILED");
              }
            }
          },
        ),
      );
    },
  };
}
