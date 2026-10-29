// SPDX-License-Identifier: LicenseRef-Proprietary

// Sends a verification link to an account: makes the link, bound to the password it is to be used with
// (verification-tokens.ts), and mails it. Never throws and never reports why a mail did not go out to the caller: the sign-up and
// the resend answer the same whatever happens here (no account enumeration). A failure is logged by its
// code only, never with the address, the message or the token.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import type { MailSender } from "../mail/sender.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import {
  verificationLink,
  verificationMessage,
} from "../mail/verification-message.ts";
import {
  issueVerificationToken,
  VERIFICATION_TOKEN_TTL_MS,
} from "./verification-tokens.ts";

export type SendVerificationMailDependencies = {
  db: Kysely<Database>;
  mail: MailSender;
  /** The configured public address of the app: the link never comes from a request header. */
  baseUrl: string;
  /** Whose name the mail carries. */
  product: ProductIdentity;
  now?: () => Date;
  log?: (message: string) => void;
};

export async function sendVerificationMail(
  {
    db,
    mail,
    baseUrl,
    product,
    now,
    log = console.error,
  }: SendVerificationMailDependencies,
  user: { id: string; email: string },
  /** The hash of the password the link is used with: the one of the sign-up this mail answers. */
  passwordHash: string,
): Promise<void> {
  try {
    const token = await issueVerificationToken(db, {
      userId: user.id,
      email: user.email,
      passwordHash,
      now,
    });
    const result = await mail.send(
      verificationMessage({
        to: user.email,
        link: verificationLink(baseUrl, token),
        validForHours: VERIFICATION_TOKEN_TTL_MS / (60 * 60 * 1000),
        product,
      }),
    );
    if (!result.ok)
      log(
        `[signup] VERIFICATION_MAIL_FAILED: a verification mail was not sent (${result.error}).`,
      );
  } catch {
    log(
      "[signup] VERIFICATION_MAIL_FAILED: a verification mail was not sent (error).",
    );
  }
}
