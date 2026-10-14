// SPDX-License-Identifier: Apache-2.0

// Pins down the token of the operator API: when it counts as usable, that the API is off otherwise,
// and that the comparison works in constant time for any lengths and characters.
import { describe, expect, it } from "vitest";
import {
  configuredOperatorToken,
  operatorTokenProblem,
  operatorTokenReuseProblem,
  operatorTokensMatch,
} from "./token.ts";

const GOOD = "operator-token-7c1e9a4b2d-5f08e3a6b1c9";
const RUNNER = "runner-token-91ac5d2e8b-7f0c14a3d6e2f5";
const SECRET = "app-secret-0123456789-0123456789-0123456789";

describe("judging the configured operator token", () => {
  // #275-T01
  it("treats an unset or blank token as not configured, without a problem", () => {
    expect(operatorTokenProblem({})).toBeNull();
    expect(operatorTokenProblem({ OPERATOR_API_TOKEN: "" })).toBeNull();
    expect(operatorTokenProblem({ OPERATOR_API_TOKEN: "   " })).toBeNull();
    expect(configuredOperatorToken({})).toBeUndefined();
    expect(configuredOperatorToken({ OPERATOR_API_TOKEN: "  \n" })).toBe(
      undefined,
    );
  });

  // #275-T02
  it("accepts a token of 32 characters or more and trims a trailing newline", () => {
    expect(operatorTokenProblem({ OPERATOR_API_TOKEN: GOOD })).toBeNull();
    expect(configuredOperatorToken({ OPERATOR_API_TOKEN: `${GOOD}\n` })).toBe(
      GOOD,
    );
    expect(
      operatorTokenProblem({ OPERATOR_API_TOKEN: "x".repeat(32) }),
    ).toBeNull();
  });

  // #275-T02
  it("refuses a token shorter than 32 characters and keeps the API off", () => {
    const env = { OPERATOR_API_TOKEN: "x".repeat(31) };
    expect(operatorTokenProblem(env)).toBe(
      "must be at least 32 characters long",
    );
    expect(configuredOperatorToken(env)).toBeUndefined();
  });

  // #275-T02
  it("refuses a token with white space or control characters inside", () => {
    for (const bad of [
      `${"x".repeat(20)} ${"y".repeat(20)}`,
      `${"x".repeat(20)}\t${"y".repeat(20)}`,
      `${"x".repeat(20)}\u0000${"y".repeat(20)}`,
      `${"x".repeat(20)} ${"y".repeat(20)}`,
    ]) {
      const env = { OPERATOR_API_TOKEN: bad };
      expect(operatorTokenProblem(env)).toBe(
        "must not contain white space or control characters",
      );
      expect(configuredOperatorToken(env)).toBeUndefined();
    }
  });

  // #275-T02
  it("refuses a token equal to RUNNER_TOKEN or APP_SECRET, naming only the variables", () => {
    const sameAsRunner = { OPERATOR_API_TOKEN: RUNNER, RUNNER_TOKEN: RUNNER };
    const sameAsSecret = { OPERATOR_API_TOKEN: SECRET, APP_SECRET: SECRET };
    expect(operatorTokenProblem(sameAsRunner)).toBe(
      "must differ from RUNNER_TOKEN",
    );
    expect(operatorTokenProblem(sameAsSecret)).toBe(
      "must differ from APP_SECRET",
    );
    expect(configuredOperatorToken(sameAsRunner)).toBeUndefined();
    expect(configuredOperatorToken(sameAsSecret)).toBeUndefined();
    // Trailing white space does not make the same value another one.
    expect(
      operatorTokenProblem({
        OPERATOR_API_TOKEN: RUNNER,
        RUNNER_TOKEN: `${RUNNER}\n`,
      }),
    ).toBe("must differ from RUNNER_TOKEN");
  });

  // #275-T02
  it("refuses a token equal to BETTER_AUTH_SECRET, the accepted older name of the master key", () => {
    const env = {
      OPERATOR_API_TOKEN: SECRET,
      APP_SECRET: "",
      BETTER_AUTH_SECRET: SECRET,
    };

    expect(operatorTokenProblem(env)).toBe(
      "must differ from BETTER_AUTH_SECRET",
    );
    expect(operatorTokenReuseProblem(env)).toBe(
      "must differ from BETTER_AUTH_SECRET",
    );
    expect(configuredOperatorToken(env)).toBeUndefined();
  });

  // #275-T02
  it("still refuses the old master key variable while APP_SECRET is set, naming the variable that matched", () => {
    const env = {
      OPERATOR_API_TOKEN: SECRET,
      APP_SECRET: "a-different-master-key-0123456789-0123456789",
      BETTER_AUTH_SECRET: SECRET,
    };

    expect(operatorTokenProblem(env)).toBe(
      "must differ from BETTER_AUTH_SECRET",
    );
  });

  // #275-T02
  it("never puts a token value into the problem text", () => {
    const problems = [
      operatorTokenProblem({ OPERATOR_API_TOKEN: "short-secret-value" }),
      operatorTokenProblem({
        OPERATOR_API_TOKEN: RUNNER,
        RUNNER_TOKEN: RUNNER,
      }),
    ];
    for (const problem of problems) {
      expect(problem).not.toContain("short-secret-value");
      expect(problem).not.toContain(RUNNER);
    }
  });
});

describe("comparing the operator token", () => {
  // #275-T04
  it("accepts only exactly the same token", () => {
    expect(operatorTokensMatch(GOOD, GOOD)).toBe(true);
    expect(operatorTokensMatch(GOOD, `${GOOD.slice(0, -1)}0`)).toBe(false);
    expect(operatorTokensMatch(GOOD, GOOD.slice(0, -1))).toBe(false);
    expect(operatorTokensMatch(GOOD, `${GOOD}!`)).toBe(false);
    expect(operatorTokensMatch(GOOD, "")).toBe(false);
  });

  // #275-T04
  it("compares any lengths and characters without throwing", () => {
    expect(operatorTokensMatch("é".repeat(40), "é".repeat(40))).toBe(true);
    expect(operatorTokensMatch("é".repeat(40), "e".repeat(40))).toBe(false);
    expect(() => operatorTokensMatch("s".repeat(40), "\ud800")).not.toThrow();
    expect(operatorTokensMatch("s".repeat(40), "x".repeat(100_000))).toBe(
      false,
    );
  });

  // #275-T04
  it("never matches when no token is configured", () => {
    expect(operatorTokensMatch(undefined, "")).toBe(false);
    expect(operatorTokensMatch(undefined, "anything")).toBe(false);
  });
});
