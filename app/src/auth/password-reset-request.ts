// SPDX-License-Identifier: Apache-2.0

// Asking for a password reset link by mail (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.3
// and 2.7). Offered only while the instance can send mail and email with password sign-in is on; without
// that the question has one answer, "not available" (the route answers 404), the same for every address.
//
// The answer must not tell whether an address has an account:
//
// - the request is counted before anything is looked up (per address, the same for every address), and
//   answers the same whether the address has an account that can sign in with a password, an account that
//   cannot (GitHub only), or none;
// - everything that depends on the account happens after the answer (`defer`): the lookup, the instance
//   counter, the link and the mail. So the time of the answer does not depend on the address either;
// - an address with no account, or with an account that has no password, gets no mail and no row.
//
// The instance counter is only touched by a mail that is really about to go out, so requests for addresses
// that have no account (the junk an outsider can send) can never use it up and keep a real reset from being
// mailed. The link is the one `completePasswordReset` accepts: 256 random bits, stored as a hash in
// `password_reset_tokens`, valid 30 minutes, used once. Several can be pending (asking again must not
// cancel the link already in the inbox); using one ends the others and every session of the account.
// A failure is logged by its code only, never with the address, the link or the token.
import type { Kysely } from "kysely";
import {
  RESET_TOKEN_TTL_MS,
  hashResetToken,
  newResetToken,
} from "../admin-cli/token.ts";
import { formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";
import type { MailSender } from "../mail/sender.ts";
import {
  passwordResetLink,
  passwordResetMessage,
} from "../mail/password-reset-message.ts";
import type { SignUpLimits } from "../signup/limits.ts";
import { canonicalEmail } from "../signup/rule.ts";
import { CREDENTIAL_PROVIDER_ID } from "./session-user.ts";

export type ResetRequestOutcome =
  | { kind: "accepted" }
  /** No mail server, or email with password sign-in is off: there is nothing to offer. */
  | { kind: "unavailable" }
  | { kind: "invalid" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export type ResetRequestDependencies = {
  db: Kysely<Database>;
  mail: MailSender;
  limits: Pick<SignUpLimits, "resetRequest" | "resetMail">;
  /** Whether people can sign in with email and password (a reset is no use otherwise). */
  emailPasswordOn: () => Promise<boolean>;
  /** The configured public address of the app: the link never comes from a request header. */
  baseUrl: string;
  /** Runs work after the answer. */
  defer: (work: Promise<void>) => void;
  now?: () => Date;
  log?: (message: string) => void;
};

/** Makes the link for an account: one row with the hash of a new token. Returns the token. */
export async function issueResetToken(
  db: Kysely<Database>,
  userId: string,
  now: () => Date = () => new Date(),
): Promise<string> {
  const token = newResetToken();
  const created = now();
  await db
    .insertInto("password_reset_tokens")
    .values({
      token_hash: hashResetToken(token),
      user_id: userId,
      created_at: formatTimestamp(created),
      expires_at: formatTimestamp(
        new Date(created.getTime() + RESET_TOKEN_TTL_MS),
      ),
      used_at: null,
    })
    .execute();
  return token;
}

// The part that depends on the account. Never throws and says nothing to anyone.
async function mailResetLink(
  {
    db,
    mail,
    limits,
    baseUrl,
    now,
    log = console.error,
  }: ResetRequestDependencies,
  email: string,
): Promise<void> {
  try {
    const account = await db
      .selectFrom("users")
      .innerJoin("accounts", "accounts.user_id", "users.id")
      .select(["users.id", "users.email", "accounts.password"])
      .where("users.email", "=", email)
      .where("accounts.provider_id", "=", CREDENTIAL_PROVIDER_ID)
      .executeTakeFirst();
    if (!account?.password) return;

    const permission = await limits.resetMail();
    if (!permission.allowed) {
      log(
        "[auth] PASSWORD_RESET_MAIL_LIMITED: the instance sent as many reset mails as it allows for now.",
      );
      return;
    }
    const token = await issueResetToken(db, account.id, now);
    const result = await mail.send(
      passwordResetMessage({
        to: account.email,
        link: passwordResetLink(baseUrl, token),
        validForMinutes: RESET_TOKEN_TTL_MS / 60_000,
      }),
    );
    if (!result.ok)
      log(
        `[auth] PASSWORD_RESET_MAIL_FAILED: a reset mail was not sent (${result.error}).`,
      );
  } catch {
    log(
      "[auth] PASSWORD_RESET_MAIL_FAILED: a reset mail was not sent (error).",
    );
  }
}

export async function requestPasswordReset(
  dependencies: ResetRequestDependencies,
  rawEmail: unknown,
): Promise<ResetRequestOutcome> {
  if (
    !(await dependencies.mail.isConfigured()) ||
    !(await dependencies.emailPasswordOn())
  )
    return { kind: "unavailable" };
  const email = canonicalEmail(rawEmail);
  if (email === null) return { kind: "invalid" };

  const permission = await dependencies.limits.resetRequest(email);
  if (!permission.allowed)
    return {
      kind: "rate_limited",
      retryAfterSeconds: permission.retryAfterSeconds,
    };

  dependencies.defer(mailResetLink(dependencies, email));
  return { kind: "accepted" };
}
