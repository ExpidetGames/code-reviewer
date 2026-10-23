// SPDX-License-Identifier: Apache-2.0

// Pins down the SMTP implementation of the mail-sender interface: it follows the settings in the store at
// every call (adding, changing and removing the mail server), delivers through the real protocol to the fake
// server, reports a failure as the stable code and logs nothing that identifies a message.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  startTestSmtp,
  TEST_SMTP_PASSWORD,
  TEST_SMTP_USER,
} from "../test-support/smtp-fake.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createSmtpConfigStore } from "./smtp-config.ts";
import { createSmtpMailSender } from "./smtp-sender.ts";

const APP_SECRET = "smtp-sender-test-secret-0123456789-0123456789";
const QUICK = {
  connectionMs: 1_500,
  greetingMs: 400,
  socketMs: 1_500,
  totalMs: 3_000,
};

async function start(auth = true) {
  const smtp = await startTestSmtp(
    auth
      ? { auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD } }
      : {},
  );
  const { db } = await createTestDatabase();
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('admin-1', 'Admin', 'admin@example.test', 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`.execute(
    db,
  );
  const config = createSmtpConfigStore({ db, appSecret: APP_SECRET });
  const logs: string[] = [];
  const sender = createSmtpMailSender({
    config,
    timeouts: QUICK,
    log: (line) => logs.push(line),
  });
  const configure = (overrides: Record<string, unknown> = {}) =>
    config.save("admin-1", {
      host: smtp.host,
      port: smtp.port,
      security: "starttls",
      allowSelfSigned: true,
      senderAddress: "reviewer@example.com",
      senderName: "code-review.com",
      ...(auth ? { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD } : {}),
      ...overrides,
    });
  return { smtp, db, config, sender, logs, configure };
}

const MESSAGE = {
  to: "person@example.com",
  subject: "Confirm your email address",
  text: "Open https://code-reviewer.example.com/verify-email?token=SECRETTOKEN0123456789012345678901234567",
};

describe("the SMTP mail sender", () => {
  it("is not configured, and refuses with not_configured, until a mail server is saved", async () => {
    const { sender, smtp } = await start();

    expect(await sender.isConfigured()).toBe(false);
    expect(await sender.send(MESSAGE)).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(smtp.sessions).toEqual([]);
  });

  // #100-SM-04
  it("sends with the saved settings, logging in with the decrypted password", async () => {
    const { sender, smtp, configure } = await start();
    await configure();

    expect(await sender.isConfigured()).toBe(true);
    const result = await sender.send(MESSAGE);

    expect(result).toEqual({ ok: true });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]?.authenticatedAs).toBe(TEST_SMTP_USER);
    expect(smtp.messages[0]?.to).toEqual(["person@example.com"]);
    expect(smtp.messages[0]?.text).toContain("SECRETTOKEN");
  });

  // #100-SM-07
  it("follows the settings at every call: a removed mail server is gone at once", async () => {
    const { sender, config, smtp, configure } = await start();
    await configure();
    await sender.send(MESSAGE);

    await config.remove();

    expect(await sender.isConfigured()).toBe(false);
    expect(await sender.send(MESSAGE)).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(smtp.messages).toHaveLength(1);
  });

  // #100-SM-09
  it("reports mail_failed when the server refuses, and logs the class and nothing of the message", async () => {
    const { sender, smtp, logs, configure } = await start();
    await configure();
    smtp.behavior.rejectRecipient = "Mailbox unavailable";

    const result = await sender.send(MESSAGE);

    expect(result).toEqual({ ok: false, error: "mail_failed" });
    expect(logs).toEqual(["[mail] MAIL_SEND_FAILED: recipient_rejected"]);
    const everything = logs.join("\n");
    expect(everything).not.toContain("SECRETTOKEN");
    expect(everything).not.toContain("person@example.com");
    expect(everything).not.toContain(TEST_SMTP_PASSWORD);
    expect(everything).not.toContain("Mailbox unavailable");
  });

  // #100-SM-09
  it("reports mail_failed, does not throw and keeps the password out of the log when the login is refused", async () => {
    const { sender, logs, configure } = await start();
    await configure({ password: "not-the-right-password-1234" });

    const result = await sender.send(MESSAGE);

    expect(result).toEqual({ ok: false, error: "mail_failed" });
    expect(logs).toEqual(["[mail] MAIL_SEND_FAILED: auth_failed"]);
    expect(logs.join("\n")).not.toContain("not-the-right-password");
  });

  // #100-SM-15
  it("reports mail_failed, not a crash, when the stored password cannot be decrypted", async () => {
    const { db, smtp, logs, configure } = await start();
    await configure();
    const other = createSmtpMailSender({
      config: createSmtpConfigStore({
        db,
        appSecret: "another-app-secret-0123456789-0123456789-xyz",
      }),
      timeouts: QUICK,
      log: (line) => logs.push(line),
    });

    // Saved, but it could never send: nothing that needs a mail server is offered.
    expect(await other.isConfigured()).toBe(false);
    expect(await other.send(MESSAGE)).toEqual({
      ok: false,
      error: "mail_failed",
    });
    expect(logs).toEqual(["[mail] MAIL_SEND_FAILED: password_unreadable"]);
    expect(smtp.sessions).toEqual([]);
  });

  it("reports mail_failed when the mail server is down", async () => {
    const { sender, smtp, configure } = await start(false);
    await configure({ port: smtp.port });
    await smtp.close();

    expect(await sender.send(MESSAGE)).toEqual({
      ok: false,
      error: "mail_failed",
    });
  });

  it("reports mail_failed when the database cannot be read", async () => {
    const { sender, db, logs, configure } = await start();
    await configure();
    await sql`drop table instance_settings`.execute(db).catch(() => undefined);

    expect(await sender.send(MESSAGE)).toEqual({
      ok: false,
      error: "mail_failed",
    });
    expect(logs).toEqual(["[mail] MAIL_SEND_FAILED: error"]);
  });
});
