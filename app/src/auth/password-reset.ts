// Setting a new password with a reset link (docs/decisions/0001-editions-setup-and-accounts.md, sections
// 2.3 and 2.7). The link carries a random 256 bit token; the database keeps its hash. A token works once
// within 30 minutes. A successful reset sets the new password and ends every session of the account, in
// one transaction. A refusal changes nothing, and says only that the link is not valid: not whether it
// was used, expired or never existed.
//
// The command `admin reset-password` (src/admin-cli/) makes the links today; the mail issue sends them
// by mail. Both end here.
import type { Kysely } from "kysely";
import { hashResetToken, isWellFormedResetToken } from "../admin-cli/token.ts";
import type { Database } from "../db/schema.ts";
import { formatTimestamp } from "../db/codecs.ts";
import { checkPassword, type PasswordErrorCode } from "./password-policy.ts";
import { CREDENTIAL_PROVIDER_ID } from "./session-user.ts";

export type PasswordResetDependencies = {
  db: Kysely<Database>;
  /** Better Auth's password hash (`context.password.hash`), so the sign in verifies the new password. */
  hashPassword: (password: string) => Promise<string>;
  now?: () => Date;
};

export type PasswordResetResult =
  | { ok: true }
  /** The link is not (or no longer) valid: unknown, used, expired or damaged. */
  | { ok: false; error: "invalid_token" }
  /** The new password does not pass the password rule; the link is still good. */
  | { ok: false; error: "invalid_password"; code: PasswordErrorCode };

// Thrown inside the transaction to undo it; never leaves this file.
class Rollback extends Error {}

/** Whether a link with this token was ever made. Used and expired links count; a malformed token does not. */
export async function isKnownResetToken(
  db: Kysely<Database>,
  token: unknown,
): Promise<boolean> {
  if (!isWellFormedResetToken(token)) return false;
  const row = await db
    .selectFrom("password_reset_tokens")
    .select("token_hash")
    .where("token_hash", "=", hashResetToken(token))
    .executeTakeFirst();
  return row !== undefined;
}

export async function completePasswordReset(
  { db, hashPassword, now = () => new Date() }: PasswordResetDependencies,
  { token, password }: { token: unknown; password: unknown },
): Promise<PasswordResetResult> {
  if (!isWellFormedResetToken(token))
    return { ok: false, error: "invalid_token" };
  const tokenHash = hashResetToken(token);

  // Look before the slow part: a link that is not valid costs nothing, and a password that does not pass
  // the rule does not use the link up.
  const known = await db
    .selectFrom("password_reset_tokens")
    .select(["user_id", "expires_at", "used_at"])
    .where("token_hash", "=", tokenHash)
    .executeTakeFirst();
  const current = formatTimestamp(now());
  if (
    known === undefined ||
    known.used_at !== null ||
    known.expires_at <= current
  )
    return { ok: false, error: "invalid_token" };

  const rule = checkPassword(typeof password === "string" ? password : "");
  if (!rule.ok)
    return { ok: false, error: "invalid_password", code: rule.code };
  const passwordHash = await hashPassword(password as string);

  try {
    await db.transaction().execute(async (trx) => {
      const at = formatTimestamp(now());
      // The token is used up by this very statement: of two requests with one link, one changes a row.
      const used = await trx
        .updateTable("password_reset_tokens")
        .set({ used_at: at })
        .where("token_hash", "=", tokenHash)
        .where("used_at", "is", null)
        .where("expires_at", ">", at)
        .executeTakeFirst();
      if (Number(used.numUpdatedRows) !== 1) throw new Rollback();

      const changed = await trx
        .updateTable("accounts")
        .set({ password: passwordHash, updated_at: at })
        .where("user_id", "=", known.user_id)
        .where("provider_id", "=", CREDENTIAL_PROVIDER_ID)
        .executeTakeFirst();
      if (Number(changed.numUpdatedRows) !== 1) throw new Rollback();

      // Whoever knew the old password, or held a session, is signed out.
      await trx
        .deleteFrom("sessions")
        .where("user_id", "=", known.user_id)
        .execute();
      // No other link of this account works any more.
      await trx
        .deleteFrom("password_reset_tokens")
        .where("user_id", "=", known.user_id)
        .where("used_at", "is", null)
        .execute();
    });
  } catch (error) {
    if (error instanceof Rollback) return { ok: false, error: "invalid_token" };
    throw error;
  }
  return { ok: true };
}
