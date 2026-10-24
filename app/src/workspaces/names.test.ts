// SPDX-License-Identifier: LicenseRef-Proprietary

// The rules for the names of a workspace: the length and the characters of the display name, the slug made
// from it, and the line-safe text that goes into mails.
import { describe, expect, it } from "vitest";
import {
  oneLine,
  slugFromName,
  uniqueSlug,
  validateWorkspaceName,
  WORKSPACE_SLUG_MAX_LENGTH,
  WORKSPACE_SLUG_PATTERN,
} from "./names.ts";

describe("the name of a workspace", () => {
  // #101-WM-03
  it("accepts 1 to 80 characters and trims the white space around it", () => {
    expect(validateWorkspaceName("  Team A  ")).toEqual({
      ok: true,
      name: "Team A",
    });
    expect(validateWorkspaceName("x")).toEqual({ ok: true, name: "x" });
    expect(validateWorkspaceName("é".repeat(80)).ok).toBe(true);
  });

  // #101-WM-03
  it.each([
    ["nothing", ""],
    ["only white space", "   "],
    ["81 characters", "a".repeat(81)],
    ["not a text", 42],
    ["a line break", "Team\nA"],
    ["a carriage return", "Team\rBcc: x"],
    ["a tab", "Team\tA"],
    ["a null character", "Team\0A"],
    ["a zero width space", "Team\u200bA"],
    ["a right to left override", "Team\u202eA"],
    ["a line separator", "Team\u2028A"],
  ])("refuses %s", (_label, value) => {
    expect(validateWorkspaceName(value)).toEqual({
      ok: false,
      error: "invalid_name",
    });
  });
});

describe("the slug of a workspace", () => {
  it.each([
    ["Team A", "team-a"],
    ["  Über Café!  ", "uber-cafe"],
    ["a---b", "a-b"],
    ["日本語", "workspace"],
    ["!!!", "workspace"],
    ["Default", "default"],
  ])("makes %s into %s", (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });

  it("stays in the alphabet of an address and within the length limit", () => {
    const slug = slugFromName("Ab ".repeat(60));

    expect(slug).toMatch(WORKSPACE_SLUG_PATTERN);
    expect(slug.length).toBeLessThanOrEqual(WORKSPACE_SLUG_MAX_LENGTH);
  });

  // #101-WM-03
  it("gets a numbered suffix when the slug is taken, and still fits the length limit", async () => {
    const taken = new Set(["team-a", "team-a-2"]);

    expect(
      await uniqueSlug("team-a", (slug) => Promise.resolve(taken.has(slug))),
    ).toBe("team-a-3");
    const long = "a".repeat(WORKSPACE_SLUG_MAX_LENGTH);
    const result = await uniqueSlug(long, (slug) =>
      Promise.resolve(slug === long),
    );
    expect(result.length).toBeLessThanOrEqual(WORKSPACE_SLUG_MAX_LENGTH);
    expect(result.endsWith("-2")).toBe(true);
  });
});

describe("text that goes into a mail", () => {
  // #101-SEC-CRLF
  it("is one line: line breaks and control characters become a space", () => {
    expect(oneLine("Evil\r\nBcc: attacker@example.test")).toBe(
      "Evil Bcc: attacker@example.test",
    );
    expect(oneLine("a\u0000b\u202ec\u2028d")).toBe("a b c d");
  });

  it("is cut to the limit with an ellipsis", () => {
    const result = oneLine("x".repeat(200), 20);

    expect([...result]).toHaveLength(20);
    expect(result.endsWith("…")).toBe(true);
  });
});
