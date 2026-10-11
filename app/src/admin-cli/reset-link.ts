// Makes a password reset link for an account, straight in the database (docs/decisions/0001-editions-
// setup-and-accounts.md, section 2.3: a lost admin password without a mail server). Having shell access
// to the container is the proof of operator rights. The link holds a random 256 bit token; the database
// keeps only its hash, valid for 30 minutes, and a new link for the same account replaces the unused
// ones. Nothing here writes the token anywhere but into the returned link.
//
// No `server-only` import and nothing of the app: the command line (cli.ts) runs this without Next.js,
// with better-sqlite3 only.
import type BetterSqlite3 from "better-sqlite3";
import { RESET_TOKEN_TTL_MS, hashResetToken, newResetToken } from "./token.ts";

/** The path of the page where somebody sets the new password. */
export const RESET_PAGE_PATH = "/reset-password";

export type ResetLinkResult =
  | { ok: true; link: string; expiresAt: string }
  /** No account has this email address. */
  | { ok: false; error: "unknown_account" }
  /** The account exists but has no password (it signs in with GitHub only): there is nothing to reset. */
  | { ok: false; error: "no_password_account" };

export function createResetLink(
  db: BetterSqlite3.Database,
  {
    email,
    baseUrl,
    now = () => new Date(),
    token = newResetToken(),
  }: {
    email: string;
    /** The public address of the app (BETTER_AUTH_URL). */
    baseUrl: string;
    now?: () => Date;
    token?: string;
  },
): ResetLinkResult {
  const normalized = email.trim().toLowerCase();
  const user = db
    .prepare("select id from users where lower(email) = ?")
    .get(normalized) as { id: string } | undefined;
  if (user === undefined) return { ok: false, error: "unknown_account" };
  const credential = db
    .prepare(
      "select id from accounts where user_id = ? and provider_id = 'credential' and password is not null and password <> ''",
    )
    .get(user.id);
  if (credential === undefined)
    return { ok: false, error: "no_password_account" };

  const created = now();
  const expiresAt = new Date(created.getTime() + RESET_TOKEN_TTL_MS);
  db.transaction(() => {
    // One link at a time per account: an older one that was never used stops working.
    db.prepare(
      "delete from password_reset_tokens where user_id = ? and used_at is null",
    ).run(user.id);
    db.prepare(
      "insert into password_reset_tokens (token_hash, user_id, created_at, expires_at, used_at) values (?, ?, ?, ?, null)",
    ).run(
      hashResetToken(token),
      user.id,
      created.toISOString(),
      expiresAt.toISOString(),
    );
  }).immediate();

  const link = new URL(RESET_PAGE_PATH, baseUrl);
  link.searchParams.set("token", token);
  return {
    ok: true,
    link: link.toString(),
    expiresAt: expiresAt.toISOString(),
  };
}
