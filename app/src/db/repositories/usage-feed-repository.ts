// SPDX-License-Identifier: Apache-2.0

// The settled usage records of EVERY workspace, in one ordered feed, for the operator API (#278). Instance level on
// purpose (like integration-directory-repository.ts and runner-jobs-repository.ts): the operator serves many
// workspaces from one token and reads what they all consumed, so there is no single workspace to scope to, and
// every item names its own. It only reads, never a `reserved` or `void` record, and nothing it returns is written
// back. The reads of ONE workspace (its page, its summary) are those of the scoped usage-records-repository.ts.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../schema.ts";
import {
  afterUsageCursor,
  toUsageRecord,
  type UsageCursor,
  type UsageRecordsPage,
} from "./usage-records-repository.ts";

export type UsageFeedRepository = {
  /**
   * Settled records after the cursor, ordered by `(settledAt, id)`. `settledBefore` keeps back the records
   * settled at or after that time (the safety lag of the operator API). An empty page returns the cursor that
   * was passed.
   */
  pageSettled(options: {
    after?: UsageCursor | undefined;
    limit: number;
    settledBefore?: string | undefined;
  }): Promise<UsageRecordsPage>;
};

export function createUsageFeedRepository(
  db: Kysely<Database>,
): UsageFeedRepository {
  return {
    async pageSettled({ after, limit, settledBefore }) {
      let query = db
        .selectFrom("usage_records")
        .selectAll()
        .where("state", "=", "settled");
      if (after !== undefined) query = query.where(afterUsageCursor(after));
      if (settledBefore !== undefined)
        query = query.where("settled_at", "<", settledBefore);
      const rows = await query
        .orderBy("settled_at")
        .orderBy("id")
        .limit(limit)
        .execute();
      const records = rows.map(toUsageRecord);
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
