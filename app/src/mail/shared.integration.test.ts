// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the sender of the running server: the SMTP_* variables of the environment have no effect, and a
// mail server saved in the portal is used from the next call on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTestSmtp } from "../test-support/smtp-fake.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { mailSenderOn } from "./shared.ts";

const APP_SECRET = "shared-mail-test-secret-0123456789-0123456789";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the mail sender of the running server", () => {
  // #100-SM-08
  it("ignores SMTP_* variables, even when they point at a live mail server", async () => {
    const smtp = await startTestSmtp();
    vi.stubEnv("SMTP_HOST", smtp.host);
    vi.stubEnv("SMTP_PORT", String(smtp.port));
    vi.stubEnv("SMTP_USER", "mailer");
    vi.stubEnv("SMTP_PASSWORD", "secret");
    vi.stubEnv("SMTP_FROM", "reviewer@example.com");
    vi.stubEnv("ALLOW_TEST_MAIL_OUTBOX", "true");
    vi.stubEnv("TEST_MAIL_OUTBOX_FILE", "/tmp/never-written.jsonl");
    const { db } = await createTestDatabase();
    const sender = mailSenderOn(db, APP_SECRET);

    expect(await sender.isConfigured()).toBe(false);
    expect(
      await sender.send({ to: "a@example.com", subject: "s", text: "t" }),
    ).toEqual({
      ok: false,
      error: "not_configured",
    });
    expect(smtp.sessions).toEqual([]);
  });
});
