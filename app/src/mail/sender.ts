// SPDX-License-Identifier: Apache-2.0

// The mail-sender interface (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.3 and 2.5).
// Everything that sends a mail (the verification link today; the password reset, the test mail and the
// invitations in the next issues) goes through `MailSender`, and everything that needs to know whether
// the instance can send mail at all (the sign-up rule, the verification gate, the admin portal) asks
// `isConfigured()`. The SMTP implementation arrives with the SMTP settings issue; until then the
// running server has no mail server (`notConfiguredMailSender`) and tests use a double
// (`src/test-support/fake-mail.ts`).
//
// Mail is never configured through environment variables, so a sender is looked up at the moment it is
// used (`getMailSender()`), never remembered: removing the mail server in the admin portal takes effect
// on the next request.

export type MailMessage = {
  /** One recipient. */
  to: string;
  subject: string;
  /** The plain text body; every message has one. */
  text: string;
  /** Optional HTML alternative of the same content. */
  html?: string;
};

export const MAIL_ERROR_CODES = [
  /** There is no mail server to send with. */
  "not_configured",
  /** The mail server did not accept the message (the reason is logged without any message content). */
  "mail_failed",
] as const;
export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];

export type MailResult = { ok: true } | { ok: false; error: MailErrorCode };

export type MailSender = {
  /** Whether a mail server is configured. Looked up on every call. */
  isConfigured(): Promise<boolean>;
  /**
   * Sends one message. Never throws: a failure is a code, so a caller can carry on (the account of a
   * sign-up exists whether or not the mail went out) and nothing in an error can carry the message.
   * Without a mail server the answer is `not_configured`.
   */
  send(message: MailMessage): Promise<MailResult>;
};

/** The sender of an instance without a mail server. */
export const notConfiguredMailSender: MailSender = {
  isConfigured: () => Promise.resolve(false),
  send: () => Promise.resolve({ ok: false, error: "not_configured" }),
};
