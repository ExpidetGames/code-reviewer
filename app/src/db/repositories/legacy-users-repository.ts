// SPDX-License-Identifier: Apache-2.0

// What the import of an existing installation reads and writes about users (src/legacy-import/): the people
// who signed in before accounts existed, with the GitHub identity and the stored GitHub token of each, and the
// mark `imported_at`. Instance level: users belong to no workspace. It reads nothing but the rows the import
// needs and never hands out a password hash.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../schema.ts";

export type LegacyUser = {
  id: string;
  /** The current GitHub login, or null for a user without one. */
  githubLogin: string | null;
  /** The numeric GitHub id of the linked GitHub account, as text, or null. */
  githubId: string | null;
  /** The access token of the old sign in as stored (encrypted), or null. Never log it. */
  accessToken: string | null;
  /** Whether the user can sign in with email and password (a credential account exists). */
  hasPassword: boolean;
  createdAt: string;
  importedAt: string | null;
};

export type LegacyUsersRepository = {
  /** Every user, oldest first (then by id). */
  list(): Promise<LegacyUser[]>;
  /** Marks every user that is not marked yet. Returns how many were marked. */
  markAllImported(at: string): Promise<number>;
  /** Ends every session of these users. Returns how many sessions were deleted. */
  deleteSessionsOf(userIds: readonly string[]): Promise<number>;
  /**
   * Empties the tokens of the earlier sign in (the GitHub OAuth app's user tokens) of every GitHub identity:
   * after the organization check they have no use. Returns how many identities held one.
   */
  clearGithubTokens(): Promise<number>;
};

export function createLegacyUsersRepository(
  db: Kysely<Database>,
): LegacyUsersRepository {
  return {
    async list() {
      const rows = await db
        .selectFrom("users")
        .leftJoin("accounts", (join) =>
          join
            .onRef("accounts.user_id", "=", "users.id")
            .on("accounts.provider_id", "=", "github"),
        )
        .select([
          "users.id as id",
          "users.github_login as github_login",
          "users.created_at as created_at",
          "users.imported_at as imported_at",
          "accounts.account_id as github_id",
          "accounts.access_token as access_token",
        ])
        .orderBy("users.created_at")
        .orderBy("users.id")
        .execute();
      const withPassword = new Set(
        (
          await db
            .selectFrom("accounts")
            .select("user_id")
            .where("provider_id", "=", "credential")
            .where("password", "is not", null)
            .execute()
        ).map((row) => row.user_id),
      );
      const seen = new Set<string>();
      const users: LegacyUser[] = [];
      for (const row of rows) {
        // One row per user: a user with two GitHub accounts (not possible since the accounts are unique) counts once.
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        users.push({
          id: row.id,
          githubLogin: row.github_login,
          githubId: row.github_id,
          accessToken: row.access_token,
          hasPassword: withPassword.has(row.id),
          createdAt: row.created_at,
          importedAt: row.imported_at,
        });
      }
      return users;
    },

    async deleteSessionsOf(userIds) {
      if (userIds.length === 0) return 0;
      const result = await db
        .deleteFrom("sessions")
        .where("user_id", "in", [...userIds])
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },

    async clearGithubTokens() {
      const result = await db
        .updateTable("accounts")
        .set({
          access_token: null,
          refresh_token: null,
          id_token: null,
          access_token_expires_at: null,
          refresh_token_expires_at: null,
        })
        .where("provider_id", "=", "github")
        .where((eb) =>
          eb.or([
            eb("access_token", "is not", null),
            eb("refresh_token", "is not", null),
            eb("id_token", "is not", null),
          ]),
        )
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async markAllImported(at) {
      const result = await db
        .updateTable("users")
        .set({ imported_at: at })
        .where("imported_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}
