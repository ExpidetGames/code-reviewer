// SPDX-License-Identifier: Apache-2.0

// Who owns a GitHub identity and who has an email address, read from the tables Better Auth keeps
// (`users`, `accounts`). The sign in decision (decide.ts) asks these two questions and nothing else.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { GITHUB_PROVIDER_ID } from "../auth/github-provider.ts";
import type { IdentityDirectory, KnownUser } from "./decide.ts";

type UserRow = {
  id: string;
  email: string;
  email_verified: number;
  imported_at: string | null;
};

export function createIdentityDirectory(
  db: Kysely<Database>,
): IdentityDirectory {
  async function githubIdOf(userId: string): Promise<string | null> {
    const account = await db
      .selectFrom("accounts")
      .select("account_id")
      .where("user_id", "=", userId)
      .where("provider_id", "=", GITHUB_PROVIDER_ID)
      .executeTakeFirst();
    return account?.account_id ?? null;
  }

  async function known(row: UserRow | undefined): Promise<KnownUser | null> {
    if (row === undefined) return null;
    return {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified === 1,
      importedAt: row.imported_at,
      githubId: await githubIdOf(row.id),
    };
  }

  return {
    async findByGithubId(githubId) {
      const row = await db
        .selectFrom("accounts")
        .innerJoin("users", "users.id", "accounts.user_id")
        .select([
          "users.id as id",
          "users.email as email",
          "users.email_verified as email_verified",
          "users.imported_at as imported_at",
        ])
        .where("accounts.provider_id", "=", GITHUB_PROVIDER_ID)
        .where("accounts.account_id", "=", githubId)
        .executeTakeFirst();
      return known(row);
    },

    async findByEmail(email) {
      if (email === "") return null;
      const row = await db
        .selectFrom("users")
        .select(["id", "email", "email_verified", "imported_at"])
        .where("email", "=", email.toLowerCase())
        .executeTakeFirst();
      return known(row);
    },
  };
}
