// SPDX-License-Identifier: Apache-2.0

// The verification token of an email address (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.5 and 2.7): 256 random bits, spelled base64url so it is safe in a link, valid for 24 hours,
// used once, and bound to the address it was made for. Only its SHA-256 hash is stored
// (`email_verification_tokens.token_hash`), so a copy of the database cannot verify an address.
//
// Making a link replaces the unused links of the user. Using one is a single guarded statement, so of two
// requests with one link only one verifies, and an address that changed since the link was made is not
// verified by it. A refusal changes nothing.
import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";

/** How long a link works. */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;
// 32 bytes in base64url, without padding.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newVerificationToken(
  random: (size: number) => Uint8Array = randomBytes,
): string {
  return Buffer.from(random(TOKEN_BYTES)).toString("base64url");
}

export function isWellFormedVerificationToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type TokenClock = { now?: () => Date };

/**
 * Makes a link for `userId` and `email`: the unused links of the user stop working, and the new token
 * (the only time it exists in the clear) is returned.
 */
export async function issueVerificationToken(
  db: Kysely<Database>,
  {
    userId,
    email,
    now = () => new Date(),
    newToken = newVerificationToken,
  }: {
    userId: string;
    email: string;
    newToken?: () => string;
  } & TokenClock,
): Promise<string> {
  const token = newToken();
  const created = now();
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("email_verification_tokens")
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .execute();
    await trx
      .insertInto("email_verification_tokens")
      .values({
        token_hash: hashVerificationToken(token),
        user_id: userId,
        email,
        created_at: formatTimestamp(created),
        expires_at: formatTimestamp(
          new Date(created.getTime() + VERIFICATION_TOKEN_TTL_MS),
        ),
        used_at: null,
      })
      .execute();
  });
  return token;
}

export type KnownVerificationToken = {
  tokenHash: string;
  userId: string;
  email: string;
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
    .select(["user_id", "email", "expires_at", "used_at"])
    .where("token_hash", "=", tokenHash)
    .executeTakeFirst();
  return row === undefined
    ? null
    : {
        tokenHash,
        userId: row.user_id,
        email: row.email,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
      };
}

export const VERIFICATION_ERROR_CODES = [
  /** Never made, damaged, or made for an address the account does not have any more. */
  "invalid_token",
  "token_expired",
  "token_used",
] as const;
export type VerificationErrorCode = (typeof VERIFICATION_ERROR_CODES)[number];

export type VerificationResult =
  { ok: true; userId: string } | { ok: false; error: VerificationErrorCode };

// Thrown inside the transaction to undo it; never leaves this file.
class Rollback extends Error {}

/** Verifies the address the token was made for. One transaction; a refusal changes nothing. */
export async function completeVerification(
  db: Kysely<Database>,
  token: unknown,
  { now = () => new Date() }: TokenClock = {},
): Promise<VerificationResult> {
  const known = await findVerificationToken(db, token);
  if (known === null) return { ok: false, error: "invalid_token" };
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

      // Only the address the link was made for: an account that has another address now is not verified.
      const verified = await trx
        .updateTable("users")
        .set({ email_verified: 1, updated_at: current })
        .where("id", "=", known.userId)
        .where("email", "=", known.email)
        .executeTakeFirst();
      if (Number(verified.numUpdatedRows) !== 1) throw new Rollback();

      // No other link of this account is needed any more.
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
