// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the notices of refused reviews of ONE workspace (the table `refusal_notices`; the factory takes the
// workspace id, see ../workspace-scope.ts): the record that a pull request got the notice in a period
// (src/refusal-notices/README.md). The unique index on the pull request and the period start is the dedupe: `begin`
// is one statement, so of several callers (several app instances included) exactly one gets the notice to post.
// A notice that was posted or dropped never changes again; one that failed is taken again only after its wait and
// only up to a number of attempts. A row of another workspace is simply not there.
import "server-only";
import type { Kysely, Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, RefusalNoticesTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import type { NoticeCode } from "../../refusal-notices/notice-text.ts";

/** Where a notice stands. `dropped`: the pull request was closed before it could be posted. */
export const NOTICE_STATES = ["pending", "posted", "dropped"] as const;
export type NoticeState = (typeof NOTICE_STATES)[number];

/** What identifies a notice inside a workspace: one per pull request and period. */
export type NoticeKey = {
  repositoryId: string;
  prNumber: number;
  /** The `period_start` of the entitlements the refusal was decided under (ISO 8601 text in UTC). */
  periodStart: string;
};

/** A notice as the rest of the app sees it. Timestamps are ISO 8601 text in UTC. */
export type StoredNotice = NoticeKey & {
  id: string;
  workspaceId: string;
  code: NoticeCode;
  state: NoticeState;
  attempts: number;
  nextAttemptAt: string;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BeginOptions = {
  /** How long the caller holds the notice: nobody else takes it before. */
  leaseMs: number;
  /** A notice that already started this many posts is not taken again. */
  maxAttempts: number;
};

export type BeginResult =
  { acquired: true; notice: StoredNotice } | { acquired: false };

export type RefusalNoticesRepository = {
  find(key: NoticeKey): Promise<StoredNotice | undefined>;
  /**
   * Takes the notice of the pull request and period for one post: inserts it (attempt 1), or, when it is
   * `pending`, its lease or wait is over and it has attempts left, counts another attempt. In every other case
   * (posted, dropped, held by another caller, out of attempts) the answer is `acquired: false`. One statement.
   */
  begin(
    key: NoticeKey,
    code: NoticeCode,
    options: BeginOptions,
  ): Promise<BeginResult>;
  /** The notice is on the pull request. */
  markPosted(id: string): Promise<void>;
  /** The pull request is closed: nothing is posted, now or later. */
  markDropped(id: string): Promise<void>;
  /** The post failed: it stays pending and may be taken again from `retryAt`. A notice that is not pending is left alone. */
  failed(id: string, retryAt: Date): Promise<void>;
};

export function toStoredNotice(
  row: Selectable<RefusalNoticesTable>,
): StoredNotice {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    prNumber: row.pr_number,
    periodStart: row.period_start,
    code: row.code as NoticeCode,
    state: row.state as NoticeState,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    postedAt: row.posted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRefusalNoticesRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): RefusalNoticesRepository {
  return {
    async find(key) {
      const row = await db
        .selectFrom("refusal_notices")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", key.repositoryId)
        .where("pr_number", "=", key.prNumber)
        .where("period_start", "=", key.periodStart)
        .executeTakeFirst();
      return row === undefined ? undefined : toStoredNotice(row);
    },

    async begin(key, code, options) {
      // The pull request must be a repository of this workspace (the table references it without its workspace).
      const own = await db
        .selectFrom("repositories")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", key.repositoryId)
        .executeTakeFirst();
      if (own === undefined) return { acquired: false };
      const current = now();
      const timestamp = formatTimestamp(current);
      const leaseEnds = formatTimestamp(
        new Date(current.getTime() + options.leaseMs),
      );
      const row = await db
        .insertInto("refusal_notices")
        .values({
          id: newId(),
          workspace_id: workspaceId,
          repository_id: key.repositoryId,
          pr_number: key.prNumber,
          period_start: key.periodStart,
          code,
          state: "pending",
          attempts: 1,
          next_attempt_at: leaseEnds,
          posted_at: null,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .onConflict((conflict) =>
          conflict
            .columns([
              "workspace_id",
              "repository_id",
              "pr_number",
              "period_start",
            ])
            .doUpdateSet((eb) => ({
              attempts: eb("refusal_notices.attempts", "+", 1),
              next_attempt_at: leaseEnds,
              updated_at: timestamp,
            }))
            .where((eb) =>
              eb.and([
                eb("refusal_notices.state", "=", "pending"),
                eb("refusal_notices.next_attempt_at", "<=", timestamp),
                eb("refusal_notices.attempts", "<", options.maxAttempts),
              ]),
            ),
        )
        .returningAll()
        .executeTakeFirst();
      return row === undefined
        ? { acquired: false }
        : { acquired: true, notice: toStoredNotice(row) };
    },

    async markPosted(id) {
      const timestamp = formatTimestamp(now());
      await db
        .updateTable("refusal_notices")
        .set({ state: "posted", posted_at: timestamp, updated_at: timestamp })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .where("state", "=", "pending")
        .execute();
    },

    async markDropped(id) {
      await db
        .updateTable("refusal_notices")
        .set({ state: "dropped", updated_at: formatTimestamp(now()) })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .where("state", "=", "pending")
        .execute();
    },

    async failed(id, retryAt) {
      await db
        .updateTable("refusal_notices")
        .set({
          next_attempt_at: formatTimestamp(retryAt),
          updated_at: formatTimestamp(now()),
        })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .where("state", "=", "pending")
        .execute();
    },
  };
}
