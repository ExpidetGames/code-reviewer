// SPDX-License-Identifier: LicenseRef-Proprietary

// The verification token of an email address (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.5 and 2.7): 256 random bits, spelled base64url so it is safe in a link, valid for 24 hours,
// used once, and bound to the address it was made for and to the password of the sign-up that made it.
// Only its SHA-256 hash is stored (`email_verification_tokens.token_hash`), so a copy of the database
// cannot verify an address.
//
// The binding to the password closes the account pre-hijack. Somebody can sign up with another person's
// address first; the other person then gets a mail (from either sign-up) and clicks. A link is used with
// the password its own sign-up chose, in the same request, and that password becomes the password of the
// account. A person who clicks a link from somebody else's sign-up does not know that password and cannot
// complete it; the account's password is never overwritten by a repeat sign-up, and a link of the person's
// own sign-up works with their own password. When one link is used, every other pending link of the
// account stops working, and so does every session the account held (when its password changed).
//
// Several links of one account can be pending at once (one per sign-up that was mailed): making one does
// not cancel the others, or somebody could keep a person's link from working by signing up again. Using
// one is a single guarded statement, so of two requests with one link only one verifies, and an address
// that changed since the link was made is not verified by it. A refusal changes nothing.
import type { Kysely } from "kysely";
import {
  hashLinkToken,
  isWellFormedLinkToken,
  newLinkToken,
} from "../admin-cli/token.ts";
import { CREDENTIAL_PROVIDER_ID } from "../auth/session-user.ts";
import { formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";

/** How long a link works. */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const newVerificationToken = newLinkToken;
export const isWellFormedVerificationToken = isWellFormedLinkToken;
export const hashVerificationToken = hashLinkToken;

export type TokenClock = { now?: () => Date };

/**
 * Makes a link for `userId` and `email` that is used with the password whose hash is `passwordHash`; the
 * new token (the only time it exists in the clear) is returned. Links made before stay pending.
 */
export async function issueVerificationToken(
  db: Kysely<Database>,
  {
    userId,
    email,
    passwordHash,
    now = () => new Date(),
    newToken = newVerificationToken,
  }: {
    userId: string;
    email: string;
    passwordHash: string;
    newToken?: () => string;
  } & TokenClock,
): Promise<string> {
  const token = newToken();
  const created = now();
  await db
    .insertInto("email_verification_tokens")
    .values({
      token_hash: hashVerificationToken(token),
      user_id: userId,
      email,
      password_hash: passwordHash,
      created_at: formatTimestamp(created),
      expires_at: formatTimestamp(
        new Date(created.getTime() + VERIFICATION_TOKEN_TTL_MS),
      ),
      used_at: null,
    })
    .execute();
  return token;
}

export type KnownVerificationToken = {
  tokenHash: string;
  userId: string;
  email: string;
  passwordHash: string;
  expiresAt: string;
  usedAt: string | null;
};

/**
 * The row of a token that was ever made (used and expired ones count), or null for a token that never
 * existed or is not shaped like one. Used to count attempts only against links that exist.
 */
export async function findVerificationToken(
  db: Kysely<Database>,
  token: unknown,
): Promise<KnownVerificationToken | null> {
  if (!isWellFormedVerificationToken(token)) return null;
  const tokenHash = hashVerificationToken(token);
  const row = await db
    .selectFrom("email_verification_tokens")
    .select(["user_id", "email", "password_hash", "expires_at", "used_at"])
    .where("token_hash", "=", tokenHash)
    .executeTakeFirst();
  return row === undefined
    ? null
    : {
        tokenHash,
        userId: row.user_id,
        email: row.email,
        passwordHash: row.password_hash,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
      };
}

export const VERIFICATION_ERROR_CODES = [
  /**
   * Never made, damaged, made for an address the account does not have any more, or the password is not
   * the one of the sign-up that made the link. These are one answer: it never says which part was wrong.
   */
  "invalid_token",
  "token_expired",
  "token_used",
] as const;
export type VerificationErrorCode = (typeof VERIFICATION_ERROR_CODES)[number];

export type VerificationResult =
  { ok: true; userId: string } | { ok: false; error: VerificationErrorCode };

export type VerifyPassword = (input: {
  hash: string;
  password: string;
}) => Promise<boolean>;

// Thrown inside the transaction to undo it; never leaves this file.
class Rollback extends Error {}

/**
 * Verifies the address the token was made for, if `password` is the password of the sign-up that made it.
 * One transaction; a refusal changes nothing. The password is checked first, so a wrong token and a wrong
 * password are the same answer, and a used or expired link is only reported to somebody who has the
 * password.
 */
export async function completeVerification(
  db: Kysely<Database>,
  token: unknown,
  password: unknown,
  {
    verifyPassword,
    now = () => new Date(),
  }: { verifyPassword: VerifyPassword } & TokenClock,
): Promise<VerificationResult> {
  const known = await findVerificationToken(db, token);
  if (known === null || typeof password !== "string")
    return { ok: false, error: "invalid_token" };
  if (!(await verifyPassword({ hash: known.passwordHash, password })))
    return { ok: false, error: "invalid_token" };
  const current = formatTimestamp(now());
  if (known.usedAt !== null) return { ok: false, error: "token_used" };
  if (known.expiresAt <= current) return { ok: false, error: "token_expired" };

  try {
    await db.transaction().execute(async (trx) => {
      // The token is used up by this very statement: of two requests with one link, one changes a row.
      const used = await trx
        .updateTable("email_verification_tokens")
        .set({ used_at: current })
        .where("token_hash", "=", known.tokenHash)
        .where("used_at", "is", null)
        .where("expires_at", ">", current)
        .executeTakeFirst();
      if (Number(used.numUpdatedRows) !== 1) throw new Rollback();

      // Only the address the link was made for, and only an account that still waits for verification.
      const verified = await trx
        .updateTable("users")
        .set({ email_verified: 1, updated_at: current })
        .where("id", "=", known.userId)
        .where("email", "=", known.email)
        .where("email_verified", "=", 0)
        .executeTakeFirst();
      if (Number(verified.numUpdatedRows) !== 1) throw new Rollback();

      // The password of the sign-up that made this link is the password of the account from now on.
      const account = await trx
        .selectFrom("accounts")
        .select("password")
        .where("user_id", "=", known.userId)
        .where("provider_id", "=", CREDENTIAL_PROVIDER_ID)
        .executeTakeFirst();
      if (account === undefined) throw new Rollback();
      if (account.password !== known.passwordHash) {
        await trx
          .updateTable("accounts")
          .set({ password: known.passwordHash, updated_at: current })
          .where("user_id", "=", known.userId)
          .where("provider_id", "=", CREDENTIAL_PROVIDER_ID)
          .execute();
        // Whoever signed in with the old password is signed out.
        await trx
          .deleteFrom("sessions")
          .where("user_id", "=", known.userId)
          .execute();
      }

      // No other link of this account is needed any more, and none may work: it was made for another
      // password.
      await trx
        .deleteFrom("email_verification_tokens")
        .where("user_id", "=", known.userId)
        .where("used_at", "is", null)
        .execute();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
    // Somebody else used the link first, or the address changed: say which, from the current rows.
    const again = await findVerificationToken(db, token);
    if (again?.usedAt != null) return { ok: false, error: "token_used" };
    return { ok: false, error: "invalid_token" };
  }
  return { ok: true, userId: known.userId };
}
