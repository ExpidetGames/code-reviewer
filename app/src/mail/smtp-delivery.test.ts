// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how the settings become the options of the mail library: what each security mode demands, that
// certificates are checked unless the admin opted out, the lowest TLS version, the time limits and that the
// library is kept away from files and addresses. The behavior behind the options is proven against the
// fake server (smtp-delivery.integration.test.ts); this is the contract of the options themselves.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverOverSmtp } from "./smtp-delivery.ts";
import type { SmtpSettings } from "./smtp-settings.ts";

const captured = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
}));
vi.mock("nodemailer", () => ({
  createTransport: (options: Record<string, unknown>) => {
    captured.options.push(options);
    return {
      sendMail: () => Promise.resolve({ accepted: ["a@example.com"] }),
      close: () => undefined,
    };
  },
}));

const BASE: SmtpSettings = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  user: "mailer",
  senderAddress: "reviewer@example.com",
  senderName: null,
  allowSelfSigned: false,
  allowPlainTextLogin: false,
};
const TIMEOUTS = {
  connectionMs: 11,
  greetingMs: 22,
  socketMs: 33,
  totalMs: 5_000,
};
const MESSAGE = { to: "a@example.com", subject: "s", text: "t" };

beforeEach(() => {
  captured.options.length = 0;
});

async function optionsFor(
  settings: SmtpSettings,
  password: string | null = "pw-value",
) {
  await deliverOverSmtp({ settings, password }, MESSAGE, TIMEOUTS);
  return captured.options.at(-1) ?? {};
}

describe("the options of the mail library", () => {
  it("demands the upgrade for STARTTLS and never tries it for none", async () => {
    const starttls = await optionsFor(BASE);
    const none = await optionsFor(
      { ...BASE, security: "none", user: null },
      null,
    );
    const tls = await optionsFor({ ...BASE, security: "tls", port: 465 });

    expect(starttls).toMatchObject({
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
    });
    expect(none).toMatchObject({
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
    });
    expect(tls).toMatchObject({
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
    });
  });

  it("checks certificates, with TLS 1.2 as the lowest version, unless the admin opted out", async () => {
    const checked = await optionsFor(BASE);
    const optedOut = await optionsFor({ ...BASE, allowSelfSigned: true });

    expect(checked.tls).toEqual({
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    expect(optedOut.tls).toEqual({
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
  });

  it("sets every time limit and keeps the library away from files and addresses", async () => {
    const options = await optionsFor(BASE);

    expect(options).toMatchObject({
      connectionTimeout: 11,
      greetingTimeout: 22,
      socketTimeout: 33,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(options.socket).toBeDefined();
  });

  it("logs in only when there is a user, and never turns the library's own logging on", async () => {
    const withLogin = await optionsFor(BASE);
    const withoutLogin = await optionsFor({ ...BASE, user: null }, null);

    expect(withLogin.auth).toEqual({ user: "mailer", pass: "pw-value" });
    expect(withoutLogin.auth).toBeUndefined();
    expect(withLogin.logger).toBeUndefined();
    expect(withLogin.debug).toBeUndefined();
  });
});
