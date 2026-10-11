// SPDX-License-Identifier: Apache-2.0

// The "send test mail" button of the admin portal (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.3): one message to the admin's own address, with the saved settings, and the class of the failure
// when it does not work (`dns_failure`, `connection_refused`, `tls_error`, `auth_failed`, `sender_rejected`,
// `timeout`, and the few more in smtp-failure.ts), with a sentence that is safe to show.
//
// The button can make the server connect to the configured host and send a mail, so it is limited: per admin
// (5 per 10 minutes) and for the whole instance (20 per 10 minutes), counted in the shared `rate_limits`
// table. A click is counted when there is a mail server to try, whether the mail then goes out or not; a
// click that finds none costs nothing. Counters that cannot be read refuse the click (the caller sees an
// exception and answers 503): they never wave it through. The message has the address of the app and
// nothing else; no secret is in it, and none is in an answer.
import { secondsLeft } from "../auth/sign-in-limit.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import type { MailMessage } from "./sender.ts";
import type { SmtpConfigStore } from "./smtp-config.ts";
import type { SmtpTimeouts } from "./smtp-delivery.ts";
import { deliverWithStoredSettings } from "./smtp-sender.ts";
import type { SmtpFailureCode } from "./smtp-failure.ts";

export const TEST_MAIL_ADMIN_MAX = 5;
export const TEST_MAIL_GLOBAL_MAX = 20;
export const TEST_MAIL_WINDOW_MS = 10 * 60 * 1000;

export function testMailAdminKey(adminId: string): string {
  return `smtp-test:admin:${adminId}`;
}
export const TEST_MAIL_GLOBAL_KEY = "smtp-test:all";

export type TestMailResult =
  | { ok: true }
  | {
      ok: false;
      error: SmtpFailureCode | "not_configured";
      /** A sentence of ours or the cleaned first line of the server's answer. */
      detail: string | null;
    }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

export type TestMailService = {
  send(admin: { id: string; email: string }): Promise<TestMailResult>;
};

export function testMessage(to: string, baseUrl: string): MailMessage {
  const text = [
    "This is a test message from Code Reviewer.",
    "",
    `It was sent by the instance at ${baseUrl} to check the mail server settings.`,
    "If you can read it, the settings work. Nobody needs to answer.",
  ].join("\n");
  const html = [
    "<p>This is a test message from Code Reviewer.</p>",
    `<p>It was sent by the instance at ${baseUrl
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")} to check the mail server settings. If you can read it, the settings work. Nobody needs to answer.</p>`,
  ].join("\n");
  return { to, subject: "Test mail from Code Reviewer", text, html };
}

export type TestMailServiceOptions = {
  config: SmtpConfigStore;
  rateLimits: RateLimitsRepository;
  /** The configured public address of the app. */
  baseUrl: string;
  timeouts?: SmtpTimeouts;
  now?: () => Date;
  log?: (line: string) => void;
};

export function createTestMailService({
  config,
  rateLimits,
  baseUrl,
  timeouts,
  now = () => new Date(),
  log = console.error,
}: TestMailServiceOptions): TestMailService {
  return {
    async send(admin) {
      if (!(await config.isConfigured()))
        return { ok: false, error: "not_configured", detail: null };

      for (const { key, max } of [
        { key: testMailAdminKey(admin.id), max: TEST_MAIL_ADMIN_MAX },
        { key: TEST_MAIL_GLOBAL_KEY, max: TEST_MAIL_GLOBAL_MAX },
      ]) {
        const hit = await rateLimits.hit(key, TEST_MAIL_WINDOW_MS);
        if (hit.count > max)
          return {
            ok: false,
            error: "rate_limited",
            retryAfterSeconds: secondsLeft(
              hit.windowStartedAt,
              TEST_MAIL_WINDOW_MS,
              now(),
            ),
          };
      }

      const result = await deliverWithStoredSettings(
        config,
        testMessage(admin.email, baseUrl),
        timeouts,
      );
      if (result.ok) return { ok: true };
      log(`[mail] TEST_MAIL_FAILED: ${result.failure.code}`);
      return { ok: false, error: result.failure.code, detail: result.failure.detail };
    },
  };
}
