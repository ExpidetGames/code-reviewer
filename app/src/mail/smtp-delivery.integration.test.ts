// SPDX-License-Identifier: Apache-2.0

// Pins down one delivery over the real protocol against the fake SMTP server: the three security modes, the
// certificate check and its explicit opt-out, the refusal to drop encryption quietly, every class of failure,
// the time limits, and the bytes that reach the server (no header can be injected, no password anywhere).
import net from "node:net";
import { describe, expect, it } from "vitest";
import type { SmtpFake } from "../../../fakes/smtp/server.ts";
import {
  startTestSmtp,
  TEST_SMTP_PASSWORD,
  TEST_SMTP_USER,
} from "../test-support/smtp-fake.ts";
import {
  deliverOverSmtp,
  isDeliverableAddress,
  safeSubject,
  type SmtpTimeouts,
} from "./smtp-delivery.ts";
import type { SmtpSettings } from "./smtp-settings.ts";

const QUICK: SmtpTimeouts = {
  connectionMs: 1_500,
  greetingMs: 400,
  socketMs: 1_500,
  totalMs: 3_000,
};

const MESSAGE = {
  to: "admin@example.com",
  subject: "Test mail from Code Reviewer",
  text: "It works.",
  html: "<p>It works.</p>",
};

function settingsFor(
  smtp: SmtpFake,
  overrides: Partial<SmtpSettings> = {},
): SmtpSettings {
  return {
    host: smtp.host,
    port: smtp.port,
    security: "starttls",
    user: null,
    senderAddress: "reviewer@example.com",
    senderName: "Code Reviewer",
    allowSelfSigned: true,
    ...overrides,
  };
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("a delivery over SMTP", () => {
  // #100-SM-04
  it("sends the message through STARTTLS with a login and the server receives it encrypted and logged in", async () => {
    const smtp = await startTestSmtp({
      auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD },
      authRequiresTls: true,
    });

    const result = await deliverOverSmtp(
      {
        settings: settingsFor(smtp, { user: TEST_SMTP_USER }),
        password: TEST_SMTP_PASSWORD,
      },
      MESSAGE,
      QUICK,
    );

    expect(result).toEqual({ ok: true });
    expect(smtp.messages).toHaveLength(1);
    const [message] = smtp.messages;
    expect(message?.secure).toBe(true);
    expect(message?.authenticatedAs).toBe(TEST_SMTP_USER);
    expect(message?.from).toBe("reviewer@example.com");
    expect(message?.to).toEqual(["admin@example.com"]);
    expect(message?.subject).toBe("Test mail from Code Reviewer");
    expect(message?.text.trim()).toBe("It works.");
    expect(message?.html.trim()).toBe("<p>It works.</p>");
    expect(message?.headers["auto-submitted"]).toEqual(["auto-generated"]);
    expect(message?.headers.from).toEqual([
      "Code Reviewer <reviewer@example.com>",
    ]);
  });

  it("sends through implicit TLS", async () => {
    const smtp = await startTestSmtp();

    const result = await deliverOverSmtp(
      {
        settings: settingsFor(smtp, {
          port: smtp.tlsPort ?? 0,
          security: "tls",
        }),
        password: null,
      },
      MESSAGE,
      QUICK,
    );

    expect(result).toEqual({ ok: true });
    expect(smtp.messages[0]?.secure).toBe(true);
  });

  it("sends without encryption when the admin chose none, and does not even try STARTTLS", async () => {
    const smtp = await startTestSmtp();

    const result = await deliverOverSmtp(
      {
        settings: settingsFor(smtp, {
          security: "none",
          allowSelfSigned: false,
        }),
        password: null,
      },
      MESSAGE,
      QUICK,
    );

    expect(result).toEqual({ ok: true });
    expect(smtp.messages[0]?.secure).toBe(false);
    expect(smtp.sessions[0]?.commands).not.toContain("STARTTLS");
  });

  // #100-SM-05
  it.each([
    ["STARTTLS", "starttls", (smtp: SmtpFake) => smtp.port],
    ["implicit TLS", "tls", (smtp: SmtpFake) => smtp.tlsPort ?? 0],
  ] as const)(
    "refuses the self-signed certificate by default on %s and sends nothing",
    async (_label, security, portOf) => {
      const smtp = await startTestSmtp({
        auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD },
      });

      const result = await deliverOverSmtp(
        {
          settings: settingsFor(smtp, {
            port: portOf(smtp),
            security,
            user: TEST_SMTP_USER,
            allowSelfSigned: false,
          }),
          password: TEST_SMTP_PASSWORD,
        },
        MESSAGE,
        QUICK,
      );

      expect(result).toMatchObject({
        ok: false,
        failure: { code: "tls_error" },
      });
      expect(smtp.messages).toEqual([]);
      for (const session of smtp.sessions)
        expect(session.commands).not.toContain("AUTH");
    },
  );

  // #100-SM-05
  it("does not fall back to plain text when STARTTLS is demanded and the server does not offer it", async () => {
    const smtp = await startTestSmtp({
      startTls: false,
      auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD },
    });

    const result = await deliverOverSmtp(
      {
        settings: settingsFor(smtp, { user: TEST_SMTP_USER }),
        password: TEST_SMTP_PASSWORD,
      },
      MESSAGE,
      QUICK,
    );

    expect(result).toMatchObject({ ok: false, failure: { code: "tls_error" } });
    expect(smtp.messages).toEqual([]);
    for (const session of smtp.sessions) {
      expect(session.commands).not.toContain("AUTH");
      expect(session.commands).not.toContain("MAIL");
    }
  });

  // #100-SM-05
  it("says tls_error when TLS is configured for a port that speaks plain SMTP", async () => {
    const smtp = await startTestSmtp();

    const result = await deliverOverSmtp(
      { settings: settingsFor(smtp, { security: "tls" }), password: null },
      MESSAGE,
      QUICK,
    );

    expect(result).toMatchObject({ ok: false, failure: { code: "tls_error" } });
  });

  // #100-SM-05
  it("says connection_refused when nothing listens", async () => {
    const smtp = await startTestSmtp();

    const result = await deliverOverSmtp(
      {
        settings: settingsFor(smtp, { port: await closedPort() }),
        password: null,
      },
      MESSAGE,
      QUICK,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "connection_refused" },
    });
  });

  // #100-SM-05
  it("says auth_failed for a wrong password, quotes the server and never the password", async () => {
    const smtp = await startTestSmtp({
      auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD },
    });
    const wrong = "wrong-password-value-98765";
    // A server that repeats what it was sent.
    smtp.behavior.authFailure = `Authentication failed for password ${wrong}`;

    const result = await deliverOverSmtp(
      {
        settings: settingsFor(smtp, { user: TEST_SMTP_USER }),
        password: wrong,
      },
      MESSAGE,
      QUICK,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "auth_failed" },
    });
    const shown = JSON.stringify(result);
    expect(shown).not.toContain(wrong);
    expect(shown).toContain("535");
    expect(smtp.messages).toEqual([]);
  });

  it("does not connect at all when a login is configured and there is no password", async () => {
    const smtp = await startTestSmtp({
      auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD },
    });

    const result = await deliverOverSmtp(
      { settings: settingsFor(smtp, { user: TEST_SMTP_USER }), password: null },
      MESSAGE,
      QUICK,
    );

    expect(result).toEqual({
      ok: false,
      failure: { code: "password_missing", detail: null },
    });
    expect(smtp.sessions).toEqual([]);
  });

  // #100-SM-05
  it("says sender_rejected and recipient_rejected, with the server's words", async () => {
    const smtp = await startTestSmtp();
    smtp.behavior.rejectSender = "Sender address not allowed";

    const sender = await deliverOverSmtp(
      { settings: settingsFor(smtp), password: null },
      MESSAGE,
      QUICK,
    );
    smtp.behavior.rejectSender = null;
    smtp.behavior.rejectRecipient = "No such mailbox";
    const recipient = await deliverOverSmtp(
      { settings: settingsFor(smtp), password: null },
      MESSAGE,
      QUICK,
    );

    expect(sender).toEqual({
      ok: false,
      failure: {
        code: "sender_rejected",
        detail: "550 5.7.1 Sender address not allowed",
      },
    });
    expect(recipient).toEqual({
      ok: false,
      failure: {
        code: "recipient_rejected",
        detail: "550 5.1.1 No such mailbox",
      },
    });
  });

  // #100-SM-05
  it("says timeout when the server accepts the connection and never answers", async () => {
    const smtp = await startTestSmtp();
    smtp.behavior.greeting = "silent";
    const started = Date.now();

    const result = await deliverOverSmtp(
      { settings: settingsFor(smtp), password: null },
      MESSAGE,
      QUICK,
    );

    expect(result).toMatchObject({ ok: false, failure: { code: "timeout" } });
    expect(Date.now() - started).toBeLessThan(QUICK.totalMs);
  });

  it("gives up after the overall limit even when every single wait is longer", async () => {
    const smtp = await startTestSmtp();
    smtp.behavior.greeting = "silent";
    const started = Date.now();

    const result = await deliverOverSmtp(
      { settings: settingsFor(smtp), password: null },
      MESSAGE,
      {
        connectionMs: 60_000,
        greetingMs: 60_000,
        socketMs: 60_000,
        totalMs: 300,
      },
    );

    expect(result).toMatchObject({ ok: false, failure: { code: "timeout" } });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("says unknown, with nothing of the library's text, when the server hangs up", async () => {
    const smtp = await startTestSmtp();
    smtp.behavior.greeting = "close";

    const result = await deliverOverSmtp(
      { settings: settingsFor(smtp), password: null },
      MESSAGE,
      QUICK,
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });
});

describe("what reaches the server", () => {
  // #100-SM-03 / header injection
  it("takes the line breaks out of a subject, so it cannot start another header", async () => {
    const smtp = await startTestSmtp();

    const result = await deliverOverSmtp(
      { settings: settingsFor(smtp), password: null },
      {
        ...MESSAGE,
        subject: "Invitation\r\nBcc: attacker@example.com\nX-Evil: 1",
      },
      QUICK,
    );

    expect(result).toEqual({ ok: true });
    const [message] = smtp.messages;
    expect(message?.headers.bcc).toBeUndefined();
    expect(message?.headers["x-evil"]).toBeUndefined();
    expect(message?.subject).toBe(
      "Invitation Bcc: attacker@example.com X-Evil: 1",
    );
    expect(message?.rawHeaderBlock).not.toMatch(/^bcc:/im);
  });

  it("takes the control characters out of the sender's display name and keeps it a name", async () => {
    const smtp = await startTestSmtp();

    const result = await deliverOverSmtp(
      {
        settings: settingsFor(smtp, {
          senderName:
            'Reviewer\r\nBcc: attacker@example.com "<evil@example.com>"',
        }),
        password: null,
      },
      MESSAGE,
      QUICK,
    );

    expect(result).toEqual({ ok: true });
    const [message] = smtp.messages;
    expect(message?.headers.bcc).toBeUndefined();
    expect(message?.to).toEqual(["admin@example.com"]);
    expect(message?.from).toBe("reviewer@example.com");
    expect(message?.rawHeaderBlock).not.toMatch(/^bcc:/im);
  });

  // #100-SM-03 / header injection
  it.each([
    "victim@example.com\r\nBcc: attacker@example.com",
    "victim@example.com\nBcc: attacker@example.com",
    "victim@example.com, attacker@example.com",
    "victim@example.com;attacker@example.com",
    "Victim <victim@example.com>",
    '"a b"@example.com',
    "victim@example.com>",
    "a@b@example.com",
    "vic tim@example.com",
    "no-at-sign",
    "",
  ])("refuses the recipient %j before connecting", async (to) => {
    const smtp = await startTestSmtp();

    const result = await deliverOverSmtp(
      { settings: settingsFor(smtp), password: null },
      { ...MESSAGE, to },
      QUICK,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "invalid_message" },
    });
    expect(smtp.sessions).toEqual([]);
  });

  it("delivers a body line that is a single dot, and a long link, intact", async () => {
    const smtp = await startTestSmtp();
    const link = `https://code-reviewer.example.com/reset-password?token=${"A1_-".repeat(11)}`;

    const result = await deliverOverSmtp(
      { settings: settingsFor(smtp), password: null },
      {
        ...MESSAGE,
        text: `Open this link:\r\n\r\n${link}\r\n.\r\nafter the dot`,
        html: `<p><a href="${link}">${link}</a></p>`,
      },
      QUICK,
    );

    expect(result).toEqual({ ok: true });
    const [message] = smtp.messages;
    expect(message?.text).toContain(link);
    expect(message?.text).toContain("\n.\n");
    expect(message?.html).toContain(link);
  });

  // #100-SM-05 / no secrets
  it("never puts the password into what the server receives", async () => {
    const smtp = await startTestSmtp({
      auth: { user: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD },
    });

    await deliverOverSmtp(
      {
        settings: settingsFor(smtp, { user: TEST_SMTP_USER }),
        password: TEST_SMTP_PASSWORD,
      },
      MESSAGE,
      QUICK,
    );

    expect(smtp.messages[0]?.raw).not.toContain(TEST_SMTP_PASSWORD);
  });
});

describe("the address and subject rules", () => {
  it("accepts an ordinary address and refuses everything that is not one", () => {
    expect(isDeliverableAddress("first.last+tag@example.co.uk")).toBe(true);
    expect(isDeliverableAddress(`${"a".repeat(250)}@example.com`)).toBe(false);
    expect(isDeliverableAddress("a@b\u2028c")).toBe(false);
  });

  it("replaces every control character of a subject with a space and cuts it", () => {
    expect(safeSubject("a\r\nb\tc\u0000d")).toBe("a b c d");
    expect(safeSubject("x".repeat(400))).toHaveLength(255);
  });
});
