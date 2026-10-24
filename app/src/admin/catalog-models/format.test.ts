// SPDX-License-Identifier: LicenseRef-Proprietary

// What the catalog screens do with text and numbers (#554): prices from micro-USD to exact dollars without a float, the
// visible cut of a long string, and the check that a link is https before it is rendered as one.
import { describe, expect, it } from "vitest";
import {
  escapeInvisible,
  formatUsdPerMTok,
  safeHttpsHref,
  stripInvisible,
  truncateText,
} from "./format.ts";

describe("a price as dollars per million tokens", () => {
  // #554-T03
  it.each([
    ["2500000", "$2.50"],
    ["3000", "$0.003"],
    ["0", "$0.00"],
    ["37500", "$0.0375"],
    ["1000000", "$1.00"],
    ["1", "$0.000001"],
    ["100000000000", "$100000.00"],
    ["123456789012", "$123456.789012"],
    ["500000", "$0.50"],
  ])("shows %s micro-USD as %s", (micro, shown) => {
    expect(formatUsdPerMTok(micro)).toBe(shown);
  });

  // #554-T03
  it("shows nothing it cannot read as a price instead of a wrong number", () => {
    for (const text of ["", "-1", "1.5", "abc", "1e6", " 7"])
      expect(formatUsdPerMTok(text)).toBe("–");
  });
});

describe("the visible cut of a long text", () => {
  // #554-T07
  it("keeps a short text and cuts a long one with an ellipsis, by characters and not by bytes", () => {
    expect(truncateText("short", 10)).toEqual({ text: "short", cut: false });
    expect(truncateText("x".repeat(30), 10)).toEqual({
      text: `${"x".repeat(9)}…`,
      cut: true,
    });
    const emoji = "😀".repeat(12);
    expect(truncateText(emoji, 10)).toEqual({
      text: `${"😀".repeat(9)}…`,
      cut: true,
    });
  });
});

describe("a link from models.dev", () => {
  // #554-T07
  it.each([
    ["https://api.example.com/v1", "https://api.example.com/v1"],
    ["https://API.example.com", "https://api.example.com/"],
  ])("is rendered for %s", (address, href) => {
    expect(safeHttpsHref(address)).toBe(href);
  });

  // #554-T07
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://api.example.com",
    "ftp://api.example.com",
    "//api.example.com",
    "api.example.com",
    "https://user:pass@api.example.com",
    "https://api.example.com/ with space",
    "https://api.example.com/\nnewline",
    "https://",
    "",
  ])("is not rendered for %j", (address) => {
    expect(safeHttpsHref(address)).toBeNull();
  });
});

describe("characters that are not seen", () => {
  // #554-T07
  it("strips format, control and line-separator characters from a text that is only shown", () => {
    expect(stripInvisible("a\u202Eb\u200Bc\u0007d\u2028e\u2029f\uFEFFg")).toBe(
      "abcdefg",
    );
    expect(stripInvisible("plain ünïcode 😀")).toBe("plain ünïcode 😀");
  });

  // #554-T07
  it("writes format and control characters as visible escapes so a text can be read as it is", () => {
    expect(escapeInvisible("a\u202Eb\u200Bc\u0007d")).toBe(
      "a\\u{202E}b\\u{200B}c\\u{7}d",
    );
    expect(escapeInvisible("plain ünïcode 😀")).toBe("plain ünïcode 😀");
  });
});
