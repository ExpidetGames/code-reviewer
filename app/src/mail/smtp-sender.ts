// SPDX-License-Identifier: Apache-2.0

// The `MailSender` of an instance with a mail server: reads the settings and the password from the store on
// every call (so adding, changing or removing the mail server in the admin portal takes effect on the next
// request), delivers through smtp-delivery.ts and turns every failure into the stable codes of the
// interface. `send` never throws and its result carries no text: a failure is logged by its class only
// (`MAIL_SEND_FAILED: <code>`), never with an address, a subject, a body, a link or a credential. The test
// mail of the admin portal asks for the class itself (`deliverWithStoredSettings`).
import type { MailMessage, MailSender } from "./sender.ts";
import type { SmtpConfigStore } from "./smtp-config.ts";
import {
  DEFAULT_SMTP_TIMEOUTS,
  deliverOverSmtp,
  type DeliveryResult,
  type SmtpTimeouts,
} from "./smtp-delivery.ts";

/** One delivery with the stored settings; the failure is a class, not an exception. */
export async function deliverWithStoredSettings(
  config: Pick<SmtpConfigStore, "resolve">,
  message: MailMessage,
  timeouts: SmtpTimeouts = DEFAULT_SMTP_TIMEOUTS,
): Promise<DeliveryResult | { ok: false; failure: { code: "not_configured"; detail: null } }> {
  const resolved = await config.resolve();
  if (resolved === null)
    return { ok: false, failure: { code: "not_configured", detail: null } };
  if (resolved.password.state === "unreadable")
    return { ok: false, failure: { code: "password_unreadable", detail: null } };
  return deliverOverSmtp(
    {
      settings: resolved.settings,
      password:
        resolved.password.state === "set"
          ? resolved.password.value.reveal()
          : null,
    },
    message,
    timeouts,
  );
}

export type SmtpMailSenderOptions = {
  config: SmtpConfigStore;
  timeouts?: SmtpTimeouts;
  log?: (line: string) => void;
};

export function createSmtpMailSender({
  config,
  timeouts = DEFAULT_SMTP_TIMEOUTS,
  log = console.error,
}: SmtpMailSenderOptions): MailSender {
  return {
    isConfigured: () => config.isConfigured(),

    async send(message) {
      try {
        const result = await deliverWithStoredSettings(config, message, timeouts);
        if (result.ok) return { ok: true };
        if (result.failure.code === "not_configured")
          return { ok: false, error: "not_configured" };
        log(`[mail] MAIL_SEND_FAILED: ${result.failure.code}`);
        return { ok: false, error: "mail_failed" };
      } catch {
        // The database or the secret store failed; the caller carries on, as it does for any failed mail.
        log("[mail] MAIL_SEND_FAILED: error");
        return { ok: false, error: "mail_failed" };
      }
    },
  };
}
