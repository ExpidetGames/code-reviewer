// SPDX-License-Identifier: Apache-2.0

// Access to the usage records of ONE workspace (the table `usage_records`; the factory takes the workspace id, see
// ../workspace-scope.ts): what each of its runs consumed (src/usage/README.md). The claim reserves a record, the
// completion of the job settles or voids it; a settled or void record never changes again. The reads are the
// only ones that exist: a count of runs by kind, the settled managed cost, and a page of settled records after a
// cursor. A record of another workspace is simply not there: a job of another workspace cannot be reserved or
// settled by id.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, UsageRecordsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import type { ProjectReviewKind } from "../../review-settings/settings.ts";
import type {
  UsageKeyMode,
  UsageSettlement,
  UsageState,
} from "../../usage/usage-records.ts";

/** A usage record as the rest of the app sees it. Timestamps are ISO 8601 text in UTC. */
export type UsageRecord = {
  id: string;
  workspaceId: string;
  jobId: string;
  reviewKind: ProjectReviewKind;
  keyMode: UsageKeyMode;
  /** The managed model tier; null until the tiers exist. */
  modelTier: string | null;
  state: UsageState;
  /** Millionths of a US dollar; null when unknown. Only a settled record has one. */
  costMicroUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reservedAt: string;
  /** Null until the record is settled (a void record has none). */
  settledAt: string | null;
};

/** Where a reader stopped in the settled records: the next page starts after this `(settledAt, id)`. */
export type UsageCursor = { settledAt: string; id: string };

export type UsageRecordsPage = {
  records: UsageRecord[];
  /** The cursor to pass for the next page: the last record's, or the cursor that was passed when the page is empty. */
  next: UsageCursor | undefined;
};

export type UsageRecordsRepository = {
  /**
   * Inserts the `reserved` record of a job of this workspace, with the kind of the job. A job that has a
   * record already (claimed again after a lost lease) keeps it: nothing is inserted or changed, so the job
   * never counts twice. A job of another workspace, or none, gets no record.
   */
  reserve(jobId: string, keyMode: UsageKeyMode): Promise<void>;
  /** Corrects the key mode of a record that is still `reserved`; any other record is left as it is. */
  setKeyMode(jobId: string, keyMode: UsageKeyMode): Promise<void>;
  /**
   * Ends the record of a job: `settled` with the cost and tokens, or `void`. Only a `reserved` record
   * changes, so repeating it does nothing. A job without a record (it was claimed before records existed)
   * gets one in its final state, with key mode `own`.
   */
  settle(jobId: string, settlement: UsageSettlement): Promise<void>;
  /**
   * Voids the `reserved` records of this workspace whose job has ended without reporting (cancelled, replaced,
   * or otherwise final), so a run that was dropped while it waited again no longer counts. Called in the
   * transaction of every transition that ends a waiting job.
   */
  voidEndedJobs(): Promise<void>;
  get(jobId: string): Promise<UsageRecord | undefined>;
  /** Records that count (`reserved` and `settled`, never `void`) reserved at or after `since`, per review kind. */
  countByKind(since: string): Promise<Record<ProjectReviewKind, number>>;
  /** The cost of the settled records of managed runs reserved at or after `since` (the period of the run, as in `countByKind`); an unknown cost adds nothing. */
  sumSettledManagedCostMicroUsd(since: string): Promise<number>;
  /** Settled records after the cursor, ordered by `(settledAt, id)`; never a `reserved` or `void` record. */
  pageSettled(options: {
    after?: UsageCursor | undefined;
    limit: number;
  }): Promise<UsageRecordsPage>;
};

function toRecord(row: Selectable<UsageRecordsTable>): UsageRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    jobId: row.job_id,
    reviewKind: row.review_kind as ProjectReviewKind,
    keyMode: row.key_mode as UsageKeyMode,
    modelTier: row.model_tier,
    state: row.state as UsageState,
    costMicroUsd: row.cost_micro_usd,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    reservedAt: row.reserved_at,
    settledAt: row.settled_at,
  };
}

/** The statuses a job never leaves (src/jobs/job-status.ts). */
const ENDED_JOB_STATUSES = ["succeeded", "failed", "cancelled", "superseded"];

export function createUsageRecordsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): UsageRecordsRepository {
  /** The job of this workspace, or undefined. */
  function jobOf(jobId: string) {
    return db
      .selectFrom("jobs")
      .select(["id", "review_kind", "claimed_at"])
      .where("id", "=", jobId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
  }

  return {
    async reserve(jobId, keyMode) {
      const job = await jobOf(jobId);
      if (job === undefined) return;
      await db
        .insertInto("usage_records")
        .values({
          id: newId(),
          workspace_id: workspaceId,
          job_id: job.id,
          review_kind: job.review_kind,
          key_mode: keyMode,
          state: "reserved",
          reserved_at: formatTimestamp(now()),
        })
        .onConflict((conflict) => conflict.column("job_id").doNothing())
        .execute();
    },

    async setKeyMode(jobId, keyMode) {
      await db
        .updateTable("usage_records")
        .set({ key_mode: keyMode })
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .where("state", "=", "reserved")
        .execute();
    },

    async settle(jobId, settlement) {
      const job = await jobOf(jobId);
      if (job === undefined) return;
      const timestamp = formatTimestamp(now());
      const final =
        settlement.state === "settled"
          ? {
              state: "settled",
              cost_micro_usd: settlement.costMicroUsd,
              prompt_tokens: settlement.promptTokens,
              completion_tokens: settlement.completionTokens,
              settled_at: timestamp,
            }
          : {
              state: "void",
              cost_micro_usd: null,
              prompt_tokens: null,
              completion_tokens: null,
              settled_at: null,
            };
      // One statement: a reserved record is ended, a final one is left alone, a missing one is created.
      await db
        .insertInto("usage_records")
        .values({
          id: newId(),
          workspace_id: workspaceId,
          job_id: job.id,
          review_kind: job.review_kind,
          key_mode: "own",
          // A job claimed before records existed: its claim is the best date of the run.
          reserved_at: job.claimed_at ?? timestamp,
          ...final,
        })
        .onConflict((conflict) =>
          conflict
            .column("job_id")
            .doUpdateSet(final)
            .where("usage_records.state", "=", "reserved")
            .where("usage_records.workspace_id", "=", workspaceId),
        )
        .execute();
    },

    async voidEndedJobs() {
      await db
        .updateTable("usage_records")
        .set({ state: "void" })
        .where("workspace_id", "=", workspaceId)
        .where("state", "=", "reserved")
        .where("job_id", "in", (eb) =>
          eb
            .selectFrom("jobs")
            .select("jobs.id")
            .where("jobs.workspace_id", "=", workspaceId)
            .where("jobs.status", "in", ENDED_JOB_STATUSES),
        )
        .execute();
    },

    async get(jobId) {
      const row = await db
        .selectFrom("usage_records")
        .selectAll()
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    },

    async countByKind(since) {
      const rows = await db
        .selectFrom("usage_records")
        .select(["review_kind", (eb) => eb.fn.countAll().as("runs")])
        .where("workspace_id", "=", workspaceId)
        .where("state", "in", ["reserved", "settled"])
        .where("reserved_at", ">=", since)
        .groupBy("review_kind")
        .execute();
      const counts: Record<ProjectReviewKind, number> = { diff: 0, dynamic: 0 };
      for (const row of rows)
        counts[row.review_kind as ProjectReviewKind] = Number(row.runs);
      return counts;
    },

    async sumSettledManagedCostMicroUsd(since) {
      const row = await db
        .selectFrom("usage_records")
        .select((eb) => eb.fn.sum("cost_micro_usd").as("total"))
        .where("workspace_id", "=", workspaceId)
        .where("state", "=", "settled")
        .where("key_mode", "=", "managed")
        .where("reserved_at", ">=", since)
        .executeTakeFirst();
      return Number(row?.total ?? 0);
    },

    async pageSettled({ after, limit }) {
      let query = db
        .selectFrom("usage_records")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("state", "=", "settled");
      if (after !== undefined)
        query = query.where(
          sql<boolean>`(settled_at > ${after.settledAt} or (settled_at = ${after.settledAt} and id > ${after.id}))`,
        );
      const rows = await query
        .orderBy("settled_at")
        .orderBy("id")
        .limit(limit)
        .execute();
      const records = rows.map(toRecord);
      const last = records.at(-1);
      return {
        records,
        next:
          last?.settledAt == null
            ? after
            : { settledAt: last.settledAt, id: last.id },
      };
    },
  };
}
