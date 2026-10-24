// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the verification mail: the link comes from the configured public address, and the message
// holds the link and nothing else that is secret.
import { describe, expect, it } from "vitest";
import {
  verificationLink,
  verificationMessage,
} from "./verification-message.ts";

describe("the verification link", () => {
  it("is built from the configured address of the app with the token in the query", () => {
    expect(verificationLink("https://reviews.example.com", "abc_DEF-123")).toBe(
      "https://reviews.example.com/verify-email?token=abc_DEF-123",
    );
  });
});

describe("the verification message", () => {
  it("is addressed to one recipient and holds the link in both bodies", () => {
    const message = verificationMessage({
      to: "a@example.com",
      link: "https://reviews.example.com/verify-email?token=t",
      validForHours: 24,
    });

    expect(message.to).toBe("a@example.com");
    expect(message.text).toContain(
      "https://reviews.example.com/verify-email?token=t",
    );
    expect(message.html).toContain(
      'href="https://reviews.example.com/verify-email?token=t"',
    );
    expect(message.text).toContain("24 hours");
  });

  it("escapes the link in the HTML body", () => {
    const message = verificationMessage({
      to: "a@example.com",
      link: 'https://x.example/?a=1&b="2"',
      validForHours: 24,
    });

    expect(message.html).not.toContain('"2"');
    expect(message.html).toContain("&amp;b=&quot;2&quot;");
  });
});
