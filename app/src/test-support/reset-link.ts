// SPDX-License-Identifier: LicenseRef-Proprietary

// A password reset link for tests, made the way a reset request makes one: the row with the hash of a new token
// (`issueResetToken`), and, like a person who asks again, the older unused links of the account are dropped. The
// link is returned, so a test can open it.
import type { Kysely } from "kysely";
import { RESET_PAGE_PATH } from "../auth/reset-paths.ts";
import { issueResetToken } from "../auth/password-reset-request.ts";
import type { Database } from "../db/schema.ts";

export type ResetLink =
  | { ok: true; link: string; token: string }
  | { ok: false; error: "unknown_account" };

export async function makeResetLink(
  db: Kysely<Database>,
  {
    email,
    baseUrl,
    now = () => new Date(),
  }: { email: string; baseUrl: string; now?: () => Date },
): Promise<ResetLink> {
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", email.trim().toLowerCase())
    .executeTakeFirst();
  if (user === undefined) return { ok: false, error: "unknown_account" };
  await db
    .deleteFrom("password_reset_tokens")
    .where("user_id", "=", user.id)
    .where("used_at", "is", null)
    .execute();
  const token = await issueResetToken(db, user.id, now);
  const link = new URL(RESET_PAGE_PATH, baseUrl);
  link.searchParams.set("token", token);
  return { ok: true, link: link.toString(), token };
}
