// SPDX-License-Identifier: Apache-2.0

// A mail sender for the test stack only: instead of sending, it appends every message as one line of JSON
// to a file, which a browser journey reads like an inbox. It exists because the SMTP implementation and
// its fake SMTP server come with the SMTP settings issue; it is switched on by two variables that only
// the test stack sets (`ALLOW_TEST_MAIL_OUTBOX=true` and `TEST_MAIL_OUTBOX_FILE`), the way the fake
// GitHub's address needs `ALLOW_TEST_GITHUB_ENDPOINTS`. The compose files do not pass them on. Mail is
// never configured through environment variables in a real deployment: without the flag the variables
// are not read at all.
import { appendFile } from "node:fs/promises";
import type { MailSender } from "./sender.ts";

export function outboxMailSender(file: string): MailSender {
  return {
    isConfigured: () => Promise.resolve(true),
    async send(message) {
      try {
        await appendFile(file, `${JSON.stringify(message)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        return { ok: true };
      } catch {
        return { ok: false, error: "mail_failed" };
      }
    },
  };
}
