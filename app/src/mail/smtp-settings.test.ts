// SPDX-License-Identifier: Apache-2.0

// Pins down the validation of the mail server settings: each field has its own stable code, a value that
// could break out of a mail header is refused wherever it would end up in one, and a refusal never contains
// the value (the password above all).
import { describe, expect, it } from "vitest";
import { parseSmtpInput } from "./smtp-settings.ts";

const VALID = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  user: "mailer",
  password: "correct horse battery staple",
  senderAddress: "reviewer@example.com",
  senderName: "Code Reviewer",
} as const;

function issuesOf(input: unknown) {
  const result = parseSmtpInput(input);
  if (result.ok) throw new Error("Expected the input to be refused.");
  return result.issues;
}

describe("the mail server settings", () => {
  it("accepts a complete set and normalizes it", () => {
    const result = parseSmtpInput({
      ...VALID,
      host: "  SMTP.Example.COM ",
      user: " mailer ",
      senderAddress: " reviewer@example.com ",
      senderName: " Code Reviewer ",
      allowSelfSigned: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        settings: {
          host: "smtp.example.com",
          port: 587,
          security: "starttls",
          user: "mailer",
          senderAddress: "reviewer@example.com",
          senderName: "Code Reviewer",
          allowSelfSigned: true,
        },
        password: { kind: "set", value: VALID.password },
      },
    });
  });

  it("makes the optional fields null and certificate checking the default", () => {
    const result = parseSmtpInput({
      host: "mail.internal",
      port: 25,
      security: "none",
      senderAddress: "reviewer@example.com",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        settings: {
          host: "mail.internal",
          port: 25,
          security: "none",
          user: null,
          senderAddress: "reviewer@example.com",
          senderName: null,
          allowSelfSigned: false,
        },
        password: { kind: "keep" },
      },
    });
  });

  // #100-SM-03
  it.each([
    [{ ...VALID, port: 0 }, "port", "port_invalid"],
    [{ ...VALID, port: 65536 }, "port", "port_invalid"],
    [{ ...VALID, port: -1 }, "port", "port_invalid"],
    [{ ...VALID, port: 587.5 }, "port", "port_invalid"],
    [{ ...VALID, port: "587" }, "port", "port_invalid"],
    [{ ...VALID, port: Number.NaN }, "port", "port_invalid"],
    [{ ...VALID, host: "" }, "host", "host_required"],
    [{ ...VALID, host: "   " }, "host", "host_required"],
    [{ ...VALID, host: undefined }, "host", "host_required"],
    [{ ...VALID, host: "smtp.example.com:587" }, "host", "host_invalid"],
    [{ ...VALID, host: "smtp://smtp.example.com" }, "host", "host_invalid"],
    [{ ...VALID, host: "smtp example.com" }, "host", "host_invalid"],
    [
      { ...VALID, host: "smtp.example.com\r\nbcc: x@y.z" },
      "host",
      "host_invalid",
    ],
    [{ ...VALID, host: "-bad.example.com" }, "host", "host_invalid"],
    [
      { ...VALID, host: `${"a".repeat(64)}.example.com` },
      "host",
      "host_invalid",
    ],
    [{ ...VALID, senderAddress: "" }, "senderAddress", "sender_required"],
    [
      { ...VALID, senderAddress: "not-an-address" },
      "senderAddress",
      "sender_invalid",
    ],
    [
      { ...VALID, senderAddress: "a@example.com\r\nBcc: evil@example.com" },
      "senderAddress",
      "sender_invalid",
    ],
    [
      { ...VALID, senderAddress: "a@example.com\nBcc: evil@example.com" },
      "senderAddress",
      "sender_invalid",
    ],
    [
      { ...VALID, senderAddress: "a b@example.com" },
      "senderAddress",
      "sender_invalid",
    ],
    [
      { ...VALID, senderName: "Reviewer\r\nBcc: evil@example.com" },
      "senderName",
      "sender_name_invalid",
    ],
    [
      { ...VALID, senderName: "Reviewer\nX: y" },
      "senderName",
      "sender_name_invalid",
    ],
    [
      { ...VALID, senderName: "Reviewer\0" },
      "senderName",
      "sender_name_invalid",
    ],
    [
      { ...VALID, senderName: "x".repeat(101) },
      "senderName",
      "sender_name_invalid",
    ],
    [{ ...VALID, security: "ssl" }, "security", "security_invalid"],
    [{ ...VALID, security: undefined }, "security", "security_invalid"],
    [{ ...VALID, user: "me\r\nx" }, "user", "user_invalid"],
    [{ ...VALID, user: "u".repeat(256) }, "user", "user_invalid"],
    [
      { ...VALID, allowSelfSigned: "yes" },
      "allowSelfSigned",
      "allow_self_signed_invalid",
    ],
    [{ ...VALID, password: "a\r\nb" }, "password", "password_invalid"],
    [{ ...VALID, password: "a\0b" }, "password", "password_invalid"],
    [{ ...VALID, password: "p".repeat(1025) }, "password", "password_too_long"],
    [{ ...VALID, password: 12345 }, "password", "password_invalid"],
    [
      { ...VALID, password: "secret", clearPassword: true },
      "password",
      "password_conflict",
    ],
    [
      { ...VALID, clearPassword: "yes" },
      "clearPassword",
      "clear_password_invalid",
    ],
  ])("refuses %j with %s: %s", (input, field, code) => {
    expect(issuesOf(input)).toContainEqual({ field, code });
  });

  it.each([null, undefined, "host", 5, [], [VALID]])(
    "refuses %j as a whole",
    (input) => {
      expect(issuesOf(input)).toEqual([
        { field: "smtp", code: "smtp_invalid" },
      ]);
    },
  );

  it("reports every wrong field at once", () => {
    const fields = issuesOf({
      ...VALID,
      host: "",
      port: 0,
      senderAddress: "x",
    }).map((issue) => issue.field);

    expect(fields.sort()).toEqual(["host", "port", "senderAddress"]);
  });

  it("allows the ports of mail and the unprivileged ports, and nothing else below 1024", () => {
    for (const port of [25, 465, 587, 1025, 2525, 65535])
      expect(parseSmtpInput({ ...VALID, port }).ok, String(port)).toBe(true);
    for (const port of [1, 22, 80, 110, 143, 443, 993, 995, 1023])
      expect(issuesOf({ ...VALID, port }), String(port)).toContainEqual({
        field: "port",
        code: "port_not_allowed",
      });
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "::1",
    "2001:db8::1",
    "localhost",
    "mailhog",
    "smtp.mail.example.co.uk",
    "mail_relay.internal",
  ])("accepts the host %s", (host) => {
    expect(parseSmtpInput({ ...VALID, host }).ok).toBe(true);
  });

  it("treats an empty password as keeping the stored one and a flag as clearing it", () => {
    const keep = parseSmtpInput({ ...VALID, password: "" });
    const absent = parseSmtpInput({ ...VALID, password: undefined });
    const clear = parseSmtpInput({
      ...VALID,
      password: undefined,
      clearPassword: true,
    });

    expect(keep.ok && keep.value.password).toEqual({ kind: "keep" });
    expect(absent.ok && absent.value.password).toEqual({ kind: "keep" });
    expect(clear.ok && clear.value.password).toEqual({ kind: "clear" });
  });

  it("does not check the certificate less for a connection without encryption, where the flag means nothing", () => {
    const result = parseSmtpInput({
      ...VALID,
      security: "none",
      allowSelfSigned: true,
    });

    expect(result.ok && result.value.settings.allowSelfSigned).toBe(false);
  });

  it("never puts a value into an issue", () => {
    const issues = issuesOf({
      ...VALID,
      password: "p".repeat(2000),
      host: "bad host with secret-looking-text",
      port: 99999,
    });

    const text = JSON.stringify(issues);
    expect(text).not.toContain("secret-looking-text");
    expect(text).not.toContain("pppp");
    for (const issue of issues)
      expect(Object.keys(issue).sort()).toEqual(["code", "field"]);
  });
});
