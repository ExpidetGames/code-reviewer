// SPDX-License-Identifier: Apache-2.0

// Access to the setup_codes table: the first-run setup code of a serverless deployment, shared by every
// instance (src/setup/database-code-store.ts). Instance level, and at most one row. Every change that two
// instances could make at the same moment is ONE statement with its condition in the WHERE clause, so
// whichever instance's statement runs second finds the row already changed:
//
// - `replace` writes the one row with an upsert on the unique `slot`;
// - `countAttempt` takes a place in the rate limit window and counts the attempt as a failure in the same
//   statement, before anything is compared (so concurrent guesses cannot get past the limit);
// - `consume` marks the code used only while it is unused (a correct code is accepted exactly once).
import "server-only";
import { type Kysely, type ExpressionBuilder } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type SetupCodeRow = {
  /** The id of this issuance. */
  id: string;
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  failures: number;
  windowStartedAt: Date | null;
  attemptsInWindow: number;
};

export type NewSetupCode = {
  id: string;
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
};

export type AttemptLimits = {
  now: Date;
  /** Length of a rate limit window. */
  windowMs: number;
  /** Attempts a window allows. */
  attemptsPerWindow: number;
  /** Wrong attempts after which the code is locked. */
  maxFailures: number;
};

export type SetupCodesRepository = {
  /** Makes `code` the one row: whatever was there (a code, its counters) is overwritten, in one statement. */
  replace(code: NewSetupCode): Promise<void>;
  /** The row, or null when no code was ever issued (or the setup is complete). */
  current(): Promise<SetupCodeRow | null>;
  /**
   * Takes one place in the rate limit window and counts the attempt as a wrong one (unless the code is
   * already used), in one statement. Null when the attempt does not count: the code is locked, expired or
   * the window is full (or the row is gone); `current()` says which.
   */
  countAttempt(id: string, limits: AttemptLimits): Promise<SetupCodeRow | null>;
  /** Marks the code used and takes back the wrong attempt `countAttempt` counted. False if it was used already. */
  consume(id: string, now: Date): Promise<boolean>;
  /** Deletes the row. */
  clear(): Promise<void>;
};

type Row = Database["setup_codes"];

function toRow(row: Row): SetupCodeRow {
  return {
    id: row.id,
    codeHash: row.code_hash,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    usedAt: row.used_at === null ? null : new Date(row.used_at),
    failures: row.failures,
    windowStartedAt:
      row.window_started_at === null ? null : new Date(row.window_started_at),
    attemptsInWindow: row.attempts_in_window,
  };
}

export function createSetupCodesRepository(
  db: Kysely<Database>,
): SetupCodesRepository {
  return {
    async replace(code) {
      // One upsert on the unique `slot`: two runs that overlap, even on an empty table, leave one row, the
      // one that wrote last, with all of its fields (a delete followed by an insert could leave two).
      const fresh = {
        id: code.id,
        code_hash: code.codeHash,
        created_at: formatTimestamp(code.createdAt),
        expires_at: formatTimestamp(code.expiresAt),
        used_at: null,
        failures: 0,
        window_started_at: null,
        attempts_in_window: 0,
      };
      await db
        .insertInto("setup_codes")
        .values({ slot: 1, ...fresh })
        .onConflict((conflict) => conflict.column("slot").doUpdateSet(fresh))
        .execute();
    },

    async current() {
      const row = await db
        .selectFrom("setup_codes")
        .selectAll()
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? null : toRow(row);
    },

    async countAttempt(id, limits) {
      const now = formatTimestamp(limits.now);
      const cutoff = formatTimestamp(
        new Date(limits.now.getTime() - limits.windowMs),
      );
      // ISO 8601 UTC text sorts like time, so the comparison is done on the text.
      const windowOver = (eb: ExpressionBuilder<Database, "setup_codes">) =>
        eb.or([
          eb("window_started_at", "is", null),
          eb("window_started_at", "<=", cutoff),
        ]);
      const row = await db
        .updateTable("setup_codes")
        .set((eb) => ({
          window_started_at: eb
            .case()
            .when(windowOver(eb))
            .then(now)
            .else(eb.ref("window_started_at"))
            .end(),
          attempts_in_window: eb
            .case()
            .when(windowOver(eb))
            .then(1)
            .else(eb("attempts_in_window", "+", 1))
            .end(),
          failures: eb
            .case()
            .when("used_at", "is", null)
            .then(eb("failures", "+", 1))
            .else(eb.ref("failures"))
            .end(),
        }))
        .where("id", "=", id)
        .where("failures", "<", limits.maxFailures)
        .where("expires_at", ">", now)
        .where((eb) =>
          eb.or([
            windowOver(eb),
            eb("attempts_in_window", "<", limits.attemptsPerWindow),
          ]),
        )
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : toRow(row);
    },

    async consume(id, now) {
      const row = await db
        .updateTable("setup_codes")
        .set((eb) => ({
          used_at: formatTimestamp(now),
          failures: eb("failures", "-", 1),
        }))
        .where("id", "=", id)
        .where("used_at", "is", null)
        .returning("id")
        .executeTakeFirst();
      return row !== undefined;
    },

    async clear() {
      await db.deleteFrom("setup_codes").execute();
    },
  };
}
