// SPDX-License-Identifier: LicenseRef-Proprietary

// For the tests that hold a lock on one connection and start a second one that must wait for it: the name that finds a backend
// in `pg_stat_activity`, and the wait until that backend waits on a lock, so the test releases the holder at a moment it can
// name instead of guessing.
import { sql, type Kysely } from "kysely";
import type { Database } from "../db/schema.ts";

/** `postgres://...?application_name=<name>`, so a backend can be found in `pg_stat_activity`. */
export function withApplicationName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", name);
  return parsed.toString();
}

/** Waits until the backend of `name` is waiting on a lock. Bounded: a bug fails the test instead of hanging. */
export async function waitForLockWait(
  db: Kysely<Database>,
  name: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where application_name = ${name} and wait_event_type = 'Lock'`.execute(
      db,
    );
    if ((rows[0]?.count ?? 0) > 0) return;
    if (Date.now() >= deadline)
      throw new Error(`Backend ${name} never waited on a lock.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
