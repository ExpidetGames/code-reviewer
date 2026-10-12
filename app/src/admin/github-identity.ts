// SPDX-License-Identifier: Apache-2.0

// Whether a user has a GitHub identity linked. "GitHub only" is refused unless the acting admin has one
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3), or they could not sign in again once
// email with password is off. The instance admin needs no workspace to use the app, so a linked identity
// is enough for them to get back in. The identity is the numeric GitHub id of a row in `accounts`.
import type { Kysely } from "kysely";
import { GITHUB_PROVIDER_ID } from "../auth/github-provider.ts";
import type { Database } from "../db/schema.ts";

export async function githubIdentityLinked(
  db: Kysely<Database>,
  userId: string,
): Promise<boolean> {
  const account = await db
    .selectFrom("accounts")
    .select("account_id")
    .where("user_id", "=", userId)
    .where("provider_id", "=", GITHUB_PROVIDER_ID)
    .executeTakeFirst();
  return account !== undefined && account.account_id !== "";
}
