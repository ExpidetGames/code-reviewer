// Pins down the reset token: 256 random bits in a link-safe spelling, only ever stored as a hash, and
// valid for 30 minutes.
import { describe, expect, it } from "vitest";
import {
  RESET_TOKEN_TTL_MS,
  hashResetToken,
  isWellFormedResetToken,
  newResetToken,
} from "./token.ts";

describe("a reset token", () => {
  it("is 256 random bits, spelled so that it survives a link", () => {
    const token = newResetToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(newResetToken()).not.toBe(token);
  });

  it("is recognized by its shape, and nothing else is", () => {
    expect(isWellFormedResetToken(newResetToken())).toBe(true);
    for (const text of [
      "",
      "short",
      "x".repeat(44),
      `${"a".repeat(42)}!`,
      5,
      null,
    ])
      expect(isWellFormedResetToken(text)).toBe(false);
  });

  it("is stored as a SHA-256 hash that does not contain the token", () => {
    const token = newResetToken();

    const hash = hashResetToken(token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashResetToken(token));
    expect(hash).not.toContain(token);
    expect(hashResetToken(newResetToken())).not.toBe(hash);
  });

  it("is valid for 30 minutes", () => {
    expect(RESET_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
  });
});
