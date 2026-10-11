// SPDX-License-Identifier: Apache-2.0

// Whether a user's linked GitHub identity would actually sign in today. "GitHub only" is refused unless
// the acting admin has one (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3), and a row
// in `accounts` is not enough: GitHub sign-in still goes through the access policy (the allow list), so
// an identity that is linked but not allowed would lock everybody out once email with password is off.
// The same policy that decides at sign-in decides here; if it cannot decide, the answer is no.
import type { Kysely } from "kysely";
import type { AccessPolicy } from "../auth/access-policy.ts";
import { GITHUB_PROVIDER_ID } from "../auth/github-provider.ts";
import type { Database } from "../db/schema.ts";

export async function githubIdentityPasses(
  db: Kysely<Database>,
  policy: AccessPolicy,
  userId: string,
): Promise<boolean> {
  const user = await db
    .selectFrom("users")
    .select([
      "id",
      "name",
      "email",
      "image",
      "github_login",
      "is_instance_admin",
      "org_checked_at",
      "org_checked_for",
    ])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (user === undefined || !user.github_login) return false;
  const account = await db
    .selectFrom("accounts")
    .select("account_id")
    .where("user_id", "=", userId)
    .where("provider_id", "=", GITHUB_PROVIDER_ID)
    .executeTakeFirst();
  if (account === undefined || !account.account_id) return false;
  try {
    const decision = await policy({
      id: user.id,
      name: user.name,
      email: user.email,
      isInstanceAdmin: user.is_instance_admin === 1,
      githubLogin: user.github_login,
      githubId: account.account_id,
      image: user.image,
      orgCheckedAt: user.org_checked_at,
      orgCheckedFor: user.org_checked_for,
    });
    return decision.allowed;
  } catch {
    // Whatever went wrong, GitHub only is not safe to switch on.
    return false;
  }
}
