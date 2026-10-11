// SPDX-License-Identifier: Apache-2.0

// The mail sender of the running server. Looked up on every call, never remembered: whether the instance
// can send mail is the admin's setting and can change at any time. Until the SMTP settings issue, there
// is no mail server (and so the sign-up rules that need one stay fail-closed), except in the test stack,
// which can point the sender at a file (`outbox-sender.ts`).
import "server-only";
import { outboxMailSender } from "./outbox-sender.ts";
import { notConfiguredMailSender, type MailSender } from "./sender.ts";

export const ALLOW_TEST_MAIL_OUTBOX_FLAG = "ALLOW_TEST_MAIL_OUTBOX";

type Env = Readonly<Record<string, string | undefined>>;

export function mailSenderFor(env: Env): MailSender {
  const file = env.TEST_MAIL_OUTBOX_FILE?.trim();
  if (env[ALLOW_TEST_MAIL_OUTBOX_FLAG]?.trim() === "true" && file)
    return outboxMailSender(file);
  return notConfiguredMailSender;
}

export function getMailSender(): MailSender {
  return mailSenderFor(process.env);
}
