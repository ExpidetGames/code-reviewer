// Pins down the shared secret check of the runner API: only the exact token passes, whatever the
// lengths and characters of the two sides, and the comparison never throws.
import { describe, expect, it } from "vitest";
import { bearerTokenOf, tokensMatch } from "./token-auth.ts";

describe("comparing the runner token", () => {
  // CR-28-T11
  it("accepts only exactly the same token", () => {
    expect(tokensMatch("correct-horse-battery", "correct-horse-battery")).toBe(
      true,
    );
  });

  // CR-28-T11
  it("refuses a token of the same length that differs in one character", () => {
    expect(tokensMatch("correct-horse-battery", "correct-horse-batterz")).toBe(
      false,
    );
  });

  // CR-28-T11
  it("refuses shorter and longer tokens, including a prefix and an extension of the real one", () => {
    expect(tokensMatch("correct-horse-battery", "correct-horse")).toBe(false);
    expect(tokensMatch("correct-horse-battery", "correct-horse-battery!")).toBe(
      false,
    );
    expect(tokensMatch("correct-horse-battery", "")).toBe(false);
  });

  // CR-28-T11
  it("compares non-ASCII tokens and refuses lookalikes without throwing", () => {
    expect(tokensMatch("sécret-tökén-✓", "sécret-tökén-✓")).toBe(true);
    expect(tokensMatch("sécret-tökén-✓", "secret-token-v")).toBe(false);
    // Same number of UTF-16 units, different bytes.
    expect(tokensMatch("aé", "ae")).toBe(false);
    // A lone surrogate is not valid text and must not make the comparison throw.
    expect(() => tokensMatch("secret", "\ud800")).not.toThrow();
    expect(tokensMatch("secret", "\ud800")).toBe(false);
  });

  // CR-28-T12
  it("never matches when no token is configured, not even an empty one", () => {
    expect(tokensMatch(undefined, "anything")).toBe(false);
    expect(tokensMatch(undefined, "")).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch("   ", "   ")).toBe(false);
  });
});

describe("reading the bearer token from the Authorization header", () => {
  it("returns the token after the Bearer scheme, whatever the case of the scheme", () => {
    expect(bearerTokenOf("Bearer abc123")).toBe("abc123");
    expect(bearerTokenOf("bearer abc123")).toBe("abc123");
    expect(bearerTokenOf("BEARER abc123")).toBe("abc123");
  });

  it("returns null for a missing header, another scheme or an empty token", () => {
    expect(bearerTokenOf(null)).toBeNull();
    expect(bearerTokenOf("")).toBeNull();
    expect(bearerTokenOf("Basic YWJjOmRlZg==")).toBeNull();
    expect(bearerTokenOf("Bearer")).toBeNull();
    expect(bearerTokenOf("Bearer ")).toBeNull();
    expect(bearerTokenOf("Bearer    ")).toBeNull();
    expect(bearerTokenOf("abc123")).toBeNull();
  });

  it("keeps everything after the scheme as the token, so a token with spaces never matches by accident", () => {
    expect(bearerTokenOf("Bearer abc 123")).toBe("abc 123");
  });
});
