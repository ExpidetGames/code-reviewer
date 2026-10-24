// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the allowed_login_pins table: the GitHub id each listed login is bound to. The only
// code that reads or writes it. The key is the lower-cased login (GitHub logins are not case
// sensitive), so a change of spelling alone never counts as another account.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type LoginPin = { login: string; githubId: string; pinnedAt: string };

export type AllowedLoginPinsRepository = {
  /**
   * Binds the login to the id unless it is bound already (a read first, then `INSERT ... ON CONFLICT
   * DO NOTHING` when there is none, so two callers at once cannot both win), then
   * returns the id the login is bound to now: the given one if this call (or an earlier one for the
   * same id) bound it, another one if somebody else was first. Null if the row is gone again.
   */
  pin(login: string, githubId: string): Promise<string | null>;
  /** The id the login is bound to, or null. */
  find(login: string): Promise<string | null>;
  /** Binds the login to the id whatever it was bound to before (a pre-set `login:id`). */
  set(
    login: string,
    githubId: string,
  ): Promise<"created" | "replaced" | "unchanged">;
  /** Deletes the pins of every login not in `keep` (lower case). Returns how many were deleted. */
  deleteUnlisted(keep: ReadonlySet<string>): Promise<number>;
  list(): Promise<LoginPin[]>;
};

export function createAllowedLoginPinsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): AllowedLoginPinsRepository {
  async function find(login: string): Promise<string | null> {
    const row = await db
      .selectFrom("allowed_login_pins")
      .select("github_id")
      .where("login", "=", login.toLowerCase())
      .executeTakeFirst();
    return row?.github_id ?? null;
  }

  return {
    find,

    async pin(login, githubId) {
      // Look first: nearly every call finds the pin, and a plain read takes no write lock.
      const existing = await find(login);
      if (existing !== null) return existing;
      await db
        .insertInto("allowed_login_pins")
        .values({
          login: login.toLowerCase(),
          github_id: githubId,
          pinned_at: formatTimestamp(now()),
        })
        .onConflict((conflict) => conflict.column("login").doNothing())
        .execute();
      return find(login);
    },

    async set(login, githubId) {
      const key = login.toLowerCase();
      return db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom("allowed_login_pins")
          .select("github_id")
          .where("login", "=", key)
          .executeTakeFirst();
        if (existing?.github_id === githubId) return "unchanged";
        const pinned_at = formatTimestamp(now());
        await trx
          .insertInto("allowed_login_pins")
          .values({ login: key, github_id: githubId, pinned_at })
          .onConflict((conflict) =>
            conflict
              .column("login")
              .doUpdateSet({ github_id: githubId, pinned_at }),
          )
          .execute();
        return existing === undefined ? "created" : "replaced";
      });
    },

    async deleteUnlisted(keep) {
      return db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom("allowed_login_pins")
          .select("login")
          .execute();
        const stale = rows
          .map((row) => row.login)
          .filter((login) => !keep.has(login));
        for (const login of stale)
          await trx
            .deleteFrom("allowed_login_pins")
            .where("login", "=", login)
            .execute();
        return stale.length;
      });
    },

    async list() {
      const rows = await db
        .selectFrom("allowed_login_pins")
        .selectAll()
        .orderBy("login")
        .execute();
      return rows.map((row) => ({
        login: row.login,
        githubId: row.github_id,
        pinnedAt: row.pinned_at,
      }));
    },
  };
}
