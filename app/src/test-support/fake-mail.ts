// SPDX-License-Identifier: Apache-2.0

// A mail sender for tests (the double of src/mail/sender.ts): it keeps every message it is asked to
// send in an outbox instead of sending it, can be switched to "not configured" (the instance without a
// mail server, or a mail server removed later) and can be told to fail. A test reads the verification
// link out of the outbox the way a person reads it from their inbox.
import type { MailMessage, MailResult, MailSender } from "../mail/sender.ts";

export type FakeMail = MailSender & {
  /** Whether the instance has a mail server. Switch it to test removing or adding SMTP. */
  configured: boolean;
  /** Every message handed to `send` while configured, oldest first. */
  outbox: MailMessage[];
  /** The next `send` fails with `mail_failed` (once). */
  failNext(): void;
  /** The messages addressed to `address`. */
  to(address: string): MailMessage[];
  /** The first link in the text of the newest message to `address`; throws when there is none. */
  lastLink(address: string): string;
  /** The token in the newest link to `address`. */
  lastToken(address: string): string;
};

export function createFakeMail(configured = true): FakeMail {
  let failing = false;
  const fake: FakeMail = {
    configured,
    outbox: [],
    isConfigured: () => Promise.resolve(fake.configured),
    send(message): Promise<MailResult> {
      if (!fake.configured)
        return Promise.resolve({ ok: false, error: "not_configured" });
      if (failing) {
        failing = false;
        return Promise.resolve({ ok: false, error: "mail_failed" });
      }
      fake.outbox.push(message);
      return Promise.resolve({ ok: true });
    },
    failNext() {
      failing = true;
    },
    to: (address) => fake.outbox.filter((message) => message.to === address),
    lastLink(address) {
      const message = fake.to(address).at(-1);
      const link =
        message === undefined ? null : /https?:\/\/\S+/.exec(message.text);
      if (link === null) throw new Error(`No mail with a link to ${address}`);
      return link[0];
    },
    lastToken(address) {
      const token = new URL(fake.lastLink(address)).searchParams.get("token");
      if (token === null) throw new Error(`No token in the link to ${address}`);
      return token;
    },
  };
  return fake;
}
