// SPDX-License-Identifier: Apache-2.0

// Access to the rate_limits table: shared counters with a window, so that every app instance counts
// the same attempts. Instance level. The caller chooses the key (one counter per key) and the
// window; `hit` counts one attempt and says how many there were in the current window.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type RateLimitHit = {
  /** Attempts in the current window, including this one. */
  count: number;
  /** When the current window began. */
  windowStartedAt: Date;
};

export type RateLimitsRepository = {
  /**
   * Counts one attempt for `key`. A window that began `windowMs` or more ago is over: the counter
   * starts again at 1. One statement, so attempts that arrive together are all counted.
   */
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
  /** Forgets the counter (for example after a successful sign in). */
  reset(key: string): Promise<void>;
  /** Deletes the counters whose window began `windowMs` or more ago. Returns how many. */
  deleteExpired(windowMs: number): Promise<number>;
};

export function createRateLimitsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): RateLimitsRepository {
  return {
    async hit(key, windowMs) {
      const current = now();
      const started = formatTimestamp(current);
      const cutoff = formatTimestamp(new Date(current.getTime() - windowMs));
      // ISO 8601 UTC text sorts like time, so the comparison is done on the text.
      const row = await db
        .insertInto("rate_limits")
        .values({ key, window_started_at: started, count: 1 })
        .onConflict((conflict) =>
          conflict.column("key").doUpdateSet((eb) => ({
            count: eb
              .case()
              .when("rate_limits.window_started_at", "<=", cutoff)
              .then(1)
              .else(eb("rate_limits.count", "+", 1))
              .end(),
            window_started_at: eb
              .case()
              .when("rate_limits.window_started_at", "<=", cutoff)
              .then(started)
              .else(eb.ref("rate_limits.window_started_at"))
              .end(),
          })),
        )
        .returning(["count", "window_started_at"])
        .executeTakeFirstOrThrow();
      return {
        count: row.count,
        windowStartedAt: new Date(row.window_started_at),
      };
    },

    async reset(key) {
      await db.deleteFrom("rate_limits").where("key", "=", key).execute();
    },

    async deleteExpired(windowMs) {
      const cutoff = formatTimestamp(new Date(now().getTime() - windowMs));
      const result = await db
        .deleteFrom("rate_limits")
        .where("window_started_at", "<=", cutoff)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
