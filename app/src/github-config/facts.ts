// SPDX-License-Identifier: LicenseRef-Proprietary

// What the portal and the account page know about GitHub identities, read from the tables Better Auth keeps:
// the GitHub account linked to a user, and the users whose placeholder address could not be replaced
// because another account has GitHub's verified address (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5). Never an address of another account: the admin sees who is affected, not whom they collide with.
import type { Kysely } from "kysely";
import { GITHUB_PROVIDER_ID } from "../auth/github-provider.ts";
import type { Database } from "../db/schema.ts";

export type GithubIdentityView = {
  /** The login shown at the last GitHub sign in or when it was linked, or null when it is not known. */
  login: string | null;
  /** The numeric GitHub id. */
  githubId: string;
};

export type EmailConflictView = {
  userId: string;
  name: string;
  login: string | null;
};

export async function readGithubIdentity(
  db: Kysely<Database>,
  userId: string,
): Promise<GithubIdentityView | null> {
  const row = await db
    .selectFrom("accounts")
    .innerJoin("users", "users.id", "accounts.user_id")
    .select(["accounts.account_id as github_id", "users.github_login as login"])
    .where("accounts.user_id", "=", userId)
    .where("accounts.provider_id", "=", GITHUB_PROVIDER_ID)
    .executeTakeFirst();
  return row === undefined
    ? null
    : { githubId: row.github_id, login: row.login };
}

/** The address of the user and whether it is still the placeholder, and the conflict the last sign in found. */
export async function readEmailState(
  db: Kysely<Database>,
  userId: string,
): Promise<{
  email: string;
  verified: boolean;
  conflict: string | null;
} | null> {
  const row = await db
    .selectFrom("users")
    .select(["email", "email_verified", "email_conflict"])
    .where("id", "=", userId)
    .executeTakeFirst();
  return row === undefined
    ? null
    : {
        email: row.email,
        verified: row.email_verified === 1,
        conflict: row.email_conflict,
      };
}

/** The users whose placeholder address stays because another account has their GitHub address. */
export async function readEmailConflicts(
  db: Kysely<Database>,
): Promise<EmailConflictView[]> {
  const rows = await db
    .selectFrom("users")
    .select(["id", "name", "github_login"])
    .where("email_conflict", "is not", null)
    .orderBy("created_at")
    .limit(100)
    .execute();
  return rows.map((row) => ({
    userId: row.id,
    name: row.name,
    login: row.github_login,
  }));
}
