// SPDX-License-Identifier: Apache-2.0

// The mail sender of the running server. Looked up on every call, never remembered: whether the instance
// can send mail, and with which server, is the admin's setting and can change at any time. Mail is never
// configured through environment variables: nothing here (or anywhere in the app) reads an SMTP_* variable.
// The settings are in the database, the password in the encrypted secret store (src/mail/smtp-config.ts).
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { getDatabase } from "../db/startup.ts";
import { createSecretStore } from "../secrets/store.ts";
import { getSecretStore } from "../secrets/shared.ts";
import type { MailSender } from "./sender.ts";
import { createSmtpConfigStore, type SmtpConfigStore } from "./smtp-config.ts";
import { createSmtpMailSender } from "./smtp-sender.ts";

/** The mail server settings on the server's database. */
export function getSmtpConfigStore(): SmtpConfigStore {
  return createSmtpConfigStore({
    db: getDatabase(),
    secrets: getSecretStore(),
  });
}

/** The sender of the running server. */
export function getMailSender(): MailSender {
  return createSmtpMailSender({ config: getSmtpConfigStore() });
}

/** The same sender over a given database and master key (tests, tools). */
export function mailSenderOn(
  db: Kysely<Database>,
  appSecret: string,
): MailSender {
  return createSmtpMailSender({
    config: createSmtpConfigStore({
      db,
      secrets: createSecretStore({ db, appSecret }),
    }),
  });
}
