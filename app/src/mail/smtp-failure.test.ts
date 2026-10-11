// SPDX-License-Identifier: Apache-2.0

// Pins down how an error of the mail library becomes a stable code with a sentence that is safe to show
// the admin: the classes of failure, and that neither the password nor a raw server reply that carries
// something secret ever gets through.
import { describe, expect, it } from "vitest";
import {
  classifySmtpError,
  sanitizeServerMessage,
  SMTP_FAILURE_CODES,
} from "./smtp-failure.ts";

function error(properties: Record<string, unknown>): Error {
  return Object.assign(new Error(String(properties.message ?? "boom")), properties);
}

describe("the classes of failure of a mail server", () => {
  // #100-SM-05
  it.each([
    [{ code: "EDNS", message: "getaddrinfo ENOTFOUND mail.example.com" }, "dns_failure"],
    [{ code: "ESOCKET", message: "getaddrinfo EAI_AGAIN mail.example.com" }, "dns_failure"],
    [{ code: "ESOCKET", message: "connect ECONNREFUSED 127.0.0.1:1", errno: -61 }, "connection_refused"],
    [{ code: "ECONNECTION", message: "connect ECONNREFUSED 10.0.0.5:25" }, "connection_refused"],
    [{ code: "ESOCKET", message: "self-signed certificate; if the root CA is installed locally" }, "tls_error"],
    [{ code: "ESOCKET", message: "certificate has expired" }, "tls_error"],
    [{ code: "ESOCKET", message: "Hostname/IP does not match certificate's altnames" }, "tls_error"],
    [{ code: "ESOCKET", message: "0A00010B:SSL routines:tls_validate_record_header:wrong version number" }, "tls_error"],
    [{ code: "ETLS", command: "STARTTLS", response: "502 5.5.1 STARTTLS not available" }, "tls_error"],
    [{ code: "EAUTH", command: "AUTH PLAIN", response: "535 5.7.8 Authentication credentials invalid" }, "auth_failed"],
    [{ code: "EENVELOPE", command: "MAIL FROM", response: "550 5.7.1 Sender denied" }, "sender_rejected"],
    [{ code: "EENVELOPE", command: "RCPT TO", response: "550 5.1.1 no such user" }, "recipient_rejected"],
    [{ code: "ETIMEDOUT", command: "CONN", message: "Greeting never received" }, "timeout"],
    [{ code: "ESOCKET", message: "Socket timed out" }, "timeout"],
    [{ code: "ETIMEOUT", message: "Connection timeout" }, "timeout"],
    [{ code: "ECONNRESET", message: "read ECONNRESET" }, "unknown"],
    [{ code: "EPROTOCOL", message: "Unexpected reply" }, "unknown"],
  ])("sorts %j as %s", (properties, expected) => {
    expect(classifySmtpError(error(properties), []).code).toBe(expected);
  });

  it("sorts something that is not an error as unknown", () => {
    expect(classifySmtpError("a string", []).code).toBe("unknown");
    expect(classifySmtpError(undefined, []).code).toBe("unknown");
    expect(classifySmtpError({ code: "EAUTH" }, []).code).toBe("auth_failed");
  });

  it("only ever produces a code of the stable set", () => {
    const codes = [
      "EDNS", "ESOCKET", "ECONNECTION", "ETLS", "EAUTH", "EENVELOPE", "ETIMEDOUT", "EWHATEVER",
    ].map((code) => classifySmtpError(error({ code }), []).code);

    for (const code of codes) expect(SMTP_FAILURE_CODES).toContain(code);
  });

  it("explains a certificate problem in its own words and not in the library's", () => {
    const failure = classifySmtpError(
      error({ code: "ESOCKET", message: "self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca" }),
      [],
    );

    expect(failure.detail).toContain("self-signed");
    expect(failure.detail).not.toContain("--use-system-ca");
  });

  it("quotes the server's own answer for a refusal, cleaned", () => {
    const failure = classifySmtpError(
      error({ code: "EAUTH", response: "535 5.7.8 Authentication credentials invalid" }),
      [],
    );

    expect(failure.detail).toBe("535 5.7.8 Authentication credentials invalid");
  });

  // #100-SM-05
  it("never lets the password through, whichever way a server repeats it", () => {
    const password = "hunter2-correct-horse";
    const failure = classifySmtpError(
      error({
        code: "EAUTH",
        message: `Invalid login: 535 bad ${password}`,
        response: `535 5.7.8 password ${password} rejected (${Buffer.from(password).toString("base64")})`,
      }),
      [password],
    );

    const shown = JSON.stringify(failure);
    expect(shown).not.toContain(password);
    expect(shown).not.toContain(Buffer.from(password).toString("base64"));
  });

  it("leaves out the raw message of the library, which can name the host and the address", () => {
    const failure = classifySmtpError(
      error({ code: "ESOCKET", message: "connect ECONNREFUSED 10.1.2.3:25" }),
      [],
    );

    expect(JSON.stringify(failure)).not.toContain("10.1.2.3");
  });
});

describe("the cleaning of a server's answer", () => {
  it("keeps the first line, as printable text, at most 200 characters", () => {
    expect(sanitizeServerMessage("550 first line\r\n550 second line", [])).toBe("550 first line");
    expect(sanitizeServerMessage("word ".repeat(100), [])).toHaveLength(200);
    expect(sanitizeServerMessage("café\u0007 ‮ bidi", [])).toBe("caf? ? bidi");
  });

  it("replaces long opaque tokens, which can be an encoded credential", () => {
    expect(
      sanitizeServerMessage("334 AHVzZXJAZXhhbXBsZS5jb20AaHVudGVyMmh1bnRlcjI=", []),
    ).toBe("334 [redacted]");
  });

  it("replaces the secrets it is given, in the clear and encoded", () => {
    const secret = "s3cr3t-value";
    const cleaned = sanitizeServerMessage(
      `535 ${secret} and ${Buffer.from(secret).toString("base64")} and ${encodeURIComponent(secret)}`,
      [secret],
    );

    expect(cleaned).not.toContain(secret);
    expect(cleaned).not.toContain(Buffer.from(secret).toString("base64"));
  });

  it("answers null when there is nothing to show", () => {
    expect(sanitizeServerMessage(undefined, [])).toBeNull();
    expect(sanitizeServerMessage(42, [])).toBeNull();
    expect(sanitizeServerMessage("   \r\n  ", [])).toBeNull();
  });
});
