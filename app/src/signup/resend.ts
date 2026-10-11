// SPDX-License-Identifier: Apache-2.0

// Asking for a new verification link (docs/decisions/0001-editions-setup-and-accounts.md, section 2.5).
// The answer is the same whether or not the address has an account that waits for verification: a link
// goes out only when it does, after the answer, and the request is counted before anything is looked up,
// so the limit refuses an unknown address exactly when it refuses a known one. Without a mail server
// there is nothing to resend, and that is the same answer for every address too.
import type { Kysely } from "kysely";
import { CREDENTIAL_PROVIDER_ID } from "../auth/session-user.ts";
import type { Database } from "../db/schema.ts";
import type { MailSender } from "../mail/sender.ts";
import type { SignUpLimits } from "./limits.ts";
import { canonicalEmail } from "./rule.ts";
import { sendVerificationMail } from "./verification-mail.ts";

export type ResendOutcome =
  | { kind: "accepted" }
  /** The instance has no mail server, so nothing can be verified or sent. */
  | { kind: "unavailable" }
  | { kind: "invalid" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export type ResendDependencies = {
  db: Kysely<Database>;
  mail: MailSender;
  limits: SignUpLimits;
  baseUrl: string;
  defer: (work: Promise<void>) => void;
  now?: () => Date;
  log?: (message: string) => void;
};

export async function resendVerification(
  { db, mail, limits, baseUrl, defer, now, log }: ResendDependencies,
  rawEmail: unknown,
): Promise<ResendOutcome> {
  if (!(await mail.isConfigured())) return { kind: "unavailable" };
  const email = canonicalEmail(rawEmail);
  if (email === null) return { kind: "invalid" };

  const permission = await limits.mail(email);
  if (!permission.allowed)
    return {
      kind: "rate_limited",
      retryAfterSeconds: permission.retryAfterSeconds,
    };

  // Only an email and password account that waits for verification gets a link.
  const waiting = await db
    .selectFrom("users")
    .innerJoin("accounts", "accounts.user_id", "users.id")
    .select(["users.id", "users.email"])
    .where("users.email", "=", email)
    .where("users.email_verified", "=", 0)
    .where("accounts.provider_id", "=", CREDENTIAL_PROVIDER_ID)
    .executeTakeFirst();
  if (waiting !== undefined)
    defer(
      sendVerificationMail(
        { db, mail, baseUrl, now, log },
        { id: waiting.id, email: waiting.email },
      ),
    );
  return { kind: "accepted" };
}
