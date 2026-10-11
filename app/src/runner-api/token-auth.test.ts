// Pins down the shared secret check of the runner API: only the exact token passes, whatever the
// lengths and characters of the two sides, and the comparison never throws.
import { describe, expect, it } from "vitest";
import {
  bearerTokenOf,
  configuredRunnerToken,
  runnerTokenProblem,
  tokensMatch,
} from "./token-auth.ts";

describe("comparing the runner token", () => {
  // CR-28-T11
  it("accepts only exactly the same token", () => {
    expect(
      tokensMatch(
        "correct-horse-battery-staple-xyz0",
        "correct-horse-battery-staple-xyz0",
      ),
    ).toBe(true);
  });

  // CR-28-T11
  it("refuses a token of the same length that differs in one character", () => {
    expect(
      tokensMatch(
        "correct-horse-battery-staple-xyz0",
        "correct-horse-battery-staple-xyz1",
      ),
    ).toBe(false);
  });

  // CR-28-T11
  it("refuses shorter and longer tokens, including a prefix and an extension of the real one", () => {
    expect(
      tokensMatch(
        "correct-horse-battery-staple-xyz0",
        "correct-horse-battery-staple",
      ),
    ).toBe(false);
    expect(
      tokensMatch(
        "correct-horse-battery-staple-xyz0",
        "correct-horse-battery-staple-xyz0!",
      ),
    ).toBe(false);
    expect(tokensMatch("correct-horse-battery-staple-xyz0", "")).toBe(false);
  });

  // CR-28-T11
  it("compares non-ASCII tokens and refuses lookalikes without throwing", () => {
    expect(
      tokensMatch(
        "sécret-tökén-✓-with-enough-length-1234",
        "sécret-tökén-✓-with-enough-length-1234",
      ),
    ).toBe(true);
    expect(
      tokensMatch(
        "sécret-tökén-✓-with-enough-length-1234",
        "secret-token-v-with-enough-length-12345",
      ),
    ).toBe(false);
    // Same number of UTF-16 units, different bytes.
    expect(tokensMatch("é".repeat(40), "e".repeat(40))).toBe(false);
    // A lone surrogate is not valid text and must not make the comparison throw.
    expect(() => tokensMatch("s".repeat(40), "\ud800")).not.toThrow();
    expect(tokensMatch("s".repeat(40), "\ud800")).toBe(false);
  });

  // CR-28-T12
  it("never matches when no token is configured, not even an empty one", () => {
    expect(tokensMatch(undefined, "anything")).toBe(false);
    expect(tokensMatch(undefined, "")).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch("   ", "   ")).toBe(false);
  });
});

describe("a configured token that is too weak", () => {
  // CR-28-T12
  it("never matches when it is shorter than 32 characters, even for the same text", () => {
    const short = "a".repeat(31);

    expect(tokensMatch(short, short)).toBe(false);
    expect(tokensMatch("a".repeat(32), "a".repeat(32))).toBe(true);
  });

  it("ignores white space around the configured token, such as a trailing newline", () => {
    const token = "b".repeat(40);

    expect(tokensMatch(`${token}\n`, token)).toBe(true);
    expect(configuredRunnerToken({ RUNNER_TOKEN: ` ${token}\n` })).toBe(token);
    expect(configuredRunnerToken({ RUNNER_TOKEN: "  " })).toBeUndefined();
    expect(configuredRunnerToken({})).toBeUndefined();
  });
});

describe("a configured token the runner would refuse", () => {
  const good = "c".repeat(40);

  // CR-51 (the runner refuses white space inside its token, settings.py)
  it.each([
    ["a space", `${good.slice(0, 20)} ${good.slice(20)}`],
    ["a tab", `${good.slice(0, 20)}\t${good.slice(20)}`],
    ["a line break", `${good.slice(0, 20)}\n${good.slice(20)}`],
    ["a control character", `${good.slice(0, 20)}\u0007${good.slice(20)}`],
    ["a no-break space", `${good.slice(0, 20)}\u00a0${good.slice(20)}`],
  ])("is not used when it holds %s", (_name, token) => {
    expect(configuredRunnerToken({ RUNNER_TOKEN: token })).toBeUndefined();
    expect(runnerTokenProblem({ RUNNER_TOKEN: token })).toBe(
      "must not contain white space or control characters",
    );
  });

  it("names the one problem of a token, or none", () => {
    expect(runnerTokenProblem({})).toBe("is not set");
    expect(runnerTokenProblem({ RUNNER_TOKEN: "  \n" })).toBe("is not set");
    expect(runnerTokenProblem({ RUNNER_TOKEN: "a".repeat(31) })).toBe(
      "must be at least 32 characters long",
    );
    expect(runnerTokenProblem({ RUNNER_TOKEN: `${good}\n` })).toBeNull();
    expect(runnerTokenProblem({ RUNNER_TOKEN: "é".repeat(40) })).toBeNull();
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
