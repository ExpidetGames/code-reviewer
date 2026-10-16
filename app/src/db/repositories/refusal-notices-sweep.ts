// SPDX-License-Identifier: Apache-2.0

// The notices of refused reviews that are due to be posted again (#281), for the cron sweep (#328) that serves the
// whole instance. Instance level on purpose, like the sweep of usage records: it reads the rows of every workspace,
// only the ones that wait for a retry, and every answer names its workspace; whatever is done next goes through
// the scoped repository (refusal-notices-repository.ts).
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import {
  toStoredNotice,
  type StoredNotice,
} from "./refusal-notices-repository.ts";

/**
 * The pending notices whose wait is over (a failed post, or an attempt that never finished), oldest first,
 * that still have attempts left. At most `limit`; one indexed read (`refusal_notices_due`).
 */
export async function listDueRefusalNotices(
  db: Kysely<Database>,
  now: Date,
  options: { limit: number; maxAttempts: number },
): Promise<StoredNotice[]> {
  const rows = await db
    .selectFrom("refusal_notices")
    .selectAll()
    .where("state", "=", "pending")
    .where("next_attempt_at", "<=", formatTimestamp(now))
    .where("attempts", "<", options.maxAttempts)
    .orderBy("next_attempt_at")
    .orderBy("id")
    .limit(options.limit)
    .execute();
  return rows.map(toStoredNotice);
}
