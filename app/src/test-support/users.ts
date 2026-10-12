// SPDX-License-Identifier: Apache-2.0

// Users, passwords and GitHub identities written straight into a test database, the way an import or the
// first-run setup leaves them. Better Auth owns these tables in the app; a test that needs a user in a certain
// state (imported, with a placeholder address, with or without a password) makes it here.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";

const AT = "2026-10-11T08:00:00.000Z";

export type TestUser = {
  id: string;
  email?: string;
  name?: string;
  emailVerified?: boolean;
  isInstanceAdmin?: boolean;
  githubLogin?: string | null;
  /** ISO 8601 time; marks the user as imported from an installation that existed before accounts. */
  importedAt?: string | null;
  /** The Better Auth password hash of an email and password credential; none when left out. */
  passwordHash?: string | null;
  /** The numeric GitHub id of a linked GitHub identity, as text; none when left out. */
  githubId?: string | null;
  createdAt?: string;
};

export async function insertUser(
  db: Kysely<Database>,
  user: TestUser,
): Promise<string> {
  await db
    .insertInto("users")
    .values({
      id: user.id,
      name: user.name ?? user.id,
      email: user.email ?? `${user.id}@example.test`,
      email_verified: user.emailVerified === true ? 1 : 0,
      image: null,
      github_login: user.githubLogin ?? null,
      imported_at: user.importedAt ?? null,
      is_instance_admin: user.isInstanceAdmin === true ? 1 : 0,
      email_conflict: null,
      org_checked_at: null,
      org_checked_for: null,
      created_at: user.createdAt ?? AT,
      updated_at: user.createdAt ?? AT,
    })
    .execute();
  if (user.passwordHash != null)
    await db
      .insertInto("accounts")
      .values({
        id: `credential-${user.id}`,
        account_id: user.id,
        provider_id: "credential",
        user_id: user.id,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: user.passwordHash,
        created_at: AT,
        updated_at: AT,
      })
      .execute();
  if (user.githubId != null)
    await db
      .insertInto("accounts")
      .values({
        id: `github-${user.id}`,
        account_id: user.githubId,
        provider_id: "github",
        user_id: user.id,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: null,
        created_at: AT,
        updated_at: AT,
      })
      .execute();
  return user.id;
}
