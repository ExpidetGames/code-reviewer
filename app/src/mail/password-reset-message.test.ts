// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the password reset mail: the link comes from the configured public address and holds the token
// in the query, the message says what the link does and for how long, and it holds nothing else that is
// secret (never a password, never the old one).
import { describe, expect, it } from "vitest";
import {
  passwordResetLink,
  passwordResetMessage,
} from "./password-reset-message.ts";
import { getProductIdentity } from "../product-identity/current.ts";

describe("the password reset link", () => {
  it("is built from the configured address of the app with the token in the query", () => {
    expect(
      passwordResetLink("https://reviews.example.com", "abc_DEF-123"),
    ).toBe("https://reviews.example.com/reset-password?token=abc_DEF-123");
  });

  it("keeps a path in the configured address out of the way of the page", () => {
    expect(passwordResetLink("https://example.com/base/", "t")).toBe(
      "https://example.com/reset-password?token=t",
    );
  });
});

describe("the password reset message", () => {
  const LINK = "https://reviews.example.com/reset-password?token=t";

  it("is addressed to one recipient and holds the link, the time and the advice to ignore it in both bodies", () => {
    const message = passwordResetMessage({
      product: getProductIdentity(),
      to: "a@example.com",
      link: LINK,
      validForMinutes: 30,
    });

    expect(message.to).toBe("a@example.com");
    expect(message.subject).toBe("Reset your password");
    for (const body of [message.text, message.html ?? ""]) {
      expect(body).toContain(LINK);
      expect(body).toContain("30 minutes");
      expect(body).toContain("ignore");
    }
  });

  it("escapes the link in the HTML body", () => {
    const message = passwordResetMessage({
      product: getProductIdentity(),
      to: "a@example.com",
      link: 'https://x.example/?a=1&b="2"',
      validForMinutes: 30,
    });

    expect(message.html).not.toContain('"2"');
    expect(message.html).toContain("&amp;b=&quot;2&quot;");
  });

  it("carries no address of the recipient in the subject, so nothing about the account is in a header line", () => {
    const message = passwordResetMessage({
      product: getProductIdentity(),
      to: "a@example.com",
      link: LINK,
      validForMinutes: 30,
    });

    expect(message.subject).not.toContain("a@example.com");
  });
});
