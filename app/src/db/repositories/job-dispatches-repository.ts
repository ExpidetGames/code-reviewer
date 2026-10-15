// SPDX-License-Identifier: Apache-2.0

// Access to `job_dispatches` (#326): where the signed wake-up call of each job stands. Instance level, like
// the lease side of the queue: the sender and the sweep serve the whole instance and work from a job id they
// already hold. The table holds a job id and counters, no repository data. The rules (when to send, what an
// answer means) are in src/dispatch/; this module only moves rows.
import "server-only";
import { sql, type Kysely } from "kysely";
import {
  DISPATCH_RESULT_CODES,
  DISPATCH_STATES,
  type DispatchResultCode,
  type DispatchState,
  type DispatchUpdate,
} from "../../dispatch/outcome.ts";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type DispatchRow = {
  jobId: string;
  state: DispatchState;
  attempts: number;
  consecutiveFailures: number;
  /** ISO 8601 text, exactly as stored (the claim of a send compares it). */
  nextDispatchAt: string;
  ackedAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: number | null;
  lastCode: DispatchResultCode | null;
};

/** A queued job that is due and whose dispatch is missing or due: the work of one sweep. */
export type DueDispatchJob = {
  jobId: string;
  reviewKind: "diff" | "dynamic";
  /** The job's lost attempts so far; the call carries the number of the attempt it is on (this plus one). */
  jobAttempts: number;
};

export type JobDispatchesRepository = {
  get(jobId: string): Promise<DispatchRow | undefined>;
  /** Makes the row for a job, unless there is one. Returns whether this call made it. */
  create(jobId: string, nextDispatchAt: Date): Promise<boolean>;
  /**
   * Takes the right to send, for everyone else, and counts the attempt: moves `next_dispatch_at` from the
   * value the caller read to `leaseUntil`, only if it still is that value and the row is not stopped. At
   * most one of several callers (the request that queued the job, the sweep, another instance) gets
   * `true`. If the sender dies, the lease runs out and the job is due again. `attempts` is therefore 0
   * exactly while the job was never claimed for a send.
   */
  claimSend(
    jobId: string,
    expectedNextDispatchAt: string,
    leaseUntil: Date,
  ): Promise<boolean>;
  /** Stores what the send came to, and when the job is to be looked at next. */
  record(jobId: string, update: DispatchUpdate, at: Date): Promise<void>;
  /**
   * The queued jobs that are due now and have no dispatch row, or whose row is due and not stopped. The
   * sweep (#328) sends these (`DispatchService.sendDue`). Oldest first.
   */
  listDue(now: Date, limit: number): Promise<DueDispatchJob[]>;
  /**
   * #328: makes the `stopped` rows of jobs that are still queued and were stopped at or before `stoppedBefore`
   * pending again, due at `at`, with the failure count reset. A Dispatcher that could not run a review kind
   * may have been updated since; the sweep asks again at a slow pace. Returns how many rows.
   */
  reviveStopped(stoppedBefore: Date, at: Date): Promise<number>;
  /**
   * #328: removes the rows of jobs that finished at or before `cutoff` (nothing reads them any more). The
   * rows of a job that is queued or running are never removed. Returns how many.
   */
  deleteFinishedBefore(cutoff: Date): Promise<number>;
};

function isState(value: string): value is DispatchState {
  return (DISPATCH_STATES as readonly string[]).includes(value);
}

function isCode(value: string): value is DispatchResultCode {
  return (DISPATCH_RESULT_CODES as readonly string[]).includes(value);
}

export function createJobDispatchesRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): JobDispatchesRepository {
  return {
    async get(jobId) {
      const row = await db
        .selectFrom("job_dispatches")
        .selectAll()
        .where("job_id", "=", jobId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      if (!isState(row.state))
        throw new Error(`Stored dispatch state ${row.state} is not known.`);
      return {
        jobId: row.job_id,
        state: row.state,
        attempts: row.attempts,
        consecutiveFailures: row.consecutive_failures,
        nextDispatchAt: row.next_dispatch_at,
        ackedAt: row.acked_at,
        lastAttemptAt: row.last_attempt_at,
        lastStatus: row.last_status,
        // A code a later release added reads as unknown rather than failing the reader.
        lastCode:
          row.last_code !== null && isCode(row.last_code)
            ? row.last_code
            : null,
      };
    },

    async create(jobId, nextDispatchAt) {
      const timestamp = formatTimestamp(now());
      const result = await db
        .insertInto("job_dispatches")
        .values({
          job_id: jobId,
          state: "pending",
          attempts: 0,
          consecutive_failures: 0,
          next_dispatch_at: formatTimestamp(nextDispatchAt),
          acked_at: null,
          last_attempt_at: null,
          last_status: null,
          last_code: null,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .onConflict((conflict) => conflict.column("job_id").doNothing())
        .executeTakeFirst();
      return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
    },

    async claimSend(jobId, expectedNextDispatchAt, leaseUntil) {
      const result = await db
        .updateTable("job_dispatches")
        .set({
          attempts: sql<number>`attempts + 1`,
          next_dispatch_at: formatTimestamp(leaseUntil),
          last_attempt_at: formatTimestamp(now()),
          updated_at: formatTimestamp(now()),
        })
        .where("job_id", "=", jobId)
        .where("next_dispatch_at", "=", expectedNextDispatchAt)
        .where("state", "<>", "stopped")
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async record(jobId, update, at) {
      await db
        .updateTable("job_dispatches")
        .set({
          state: update.state,
          consecutive_failures: update.consecutiveFailures,
          next_dispatch_at: formatTimestamp(update.nextDispatchAt),
          ...(update.acknowledged ? { acked_at: formatTimestamp(at) } : {}),
          last_status: update.lastStatus,
          last_code: update.lastCode,
          updated_at: formatTimestamp(now()),
        })
        .where("job_id", "=", jobId)
        .execute();
    },

    async reviveStopped(stoppedBefore, at) {
      const timestamp = formatTimestamp(at);
      const result = await db
        .updateTable("job_dispatches")
        .set({
          state: "pending",
          consecutive_failures: 0,
          next_dispatch_at: timestamp,
          updated_at: timestamp,
        })
        .where("state", "=", "stopped")
        .where("updated_at", "<=", formatTimestamp(stoppedBefore))
        .where("job_id", "in", (eb) =>
          eb
            .selectFrom("jobs")
            .select("jobs.id")
            .where("jobs.status", "=", "queued"),
        )
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async deleteFinishedBefore(cutoff) {
      const result = await db
        .deleteFrom("job_dispatches")
        .where("job_id", "in", (eb) =>
          eb
            .selectFrom("jobs")
            .select("jobs.id")
            .where("jobs.finished_at", "<=", formatTimestamp(cutoff)),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },

    async listDue(at, limit) {
      const timestamp = formatTimestamp(at);
      const rows = await db
        .selectFrom("jobs")
        .leftJoin("job_dispatches", "job_dispatches.job_id", "jobs.id")
        .select([
          "jobs.id as job_id",
          "jobs.review_kind as review_kind",
          "jobs.attempts as job_attempts",
        ])
        .where("jobs.status", "=", "queued")
        .where("jobs.run_after", "<=", timestamp)
        .where((eb) =>
          eb.or([
            eb("job_dispatches.job_id", "is", null),
            eb.and([
              eb("job_dispatches.state", "<>", "stopped"),
              eb("job_dispatches.next_dispatch_at", "<=", timestamp),
            ]),
          ]),
        )
        .orderBy("jobs.run_after")
        .orderBy("jobs.id")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        jobId: row.job_id,
        reviewKind: row.review_kind === "dynamic" ? "dynamic" : "diff",
        jobAttempts: row.job_attempts,
      }));
    },
  };
}
