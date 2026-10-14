// SPDX-License-Identifier: Apache-2.0

// Pins down the one line the start logs about the operator API: whether it is on, and when a token is set but not
// usable, why (the variable name and the rule, never the value).
import { describe, expect, it, vi } from "vitest";
import { logOperatorApiState, operatorApiStateLine } from "./startup.ts";

const GOOD = "operator-token-7c1e9a4b2d-5f08e3a6b1c9";

describe("the start line of the operator API", () => {
  // #275-T01
  it("says the API is off when no token is set", () => {
    expect(operatorApiStateLine({})).toBe(
      "[operator-api] off: OPERATOR_API_TOKEN is not set.",
    );
  });

  // #275-T02
  it("says the API is on, without the token", () => {
    const line = operatorApiStateLine({ OPERATOR_API_TOKEN: GOOD });

    expect(line).toBe("[operator-api] on.");
    expect(line).not.toContain(GOOD);
  });

  // #275-T02
  it("says why a token that is set stays off, naming only the variable", () => {
    const weak = operatorApiStateLine({ OPERATOR_API_TOKEN: "weak-value" });
    const reused = operatorApiStateLine({
      OPERATOR_API_TOKEN: GOOD,
      RUNNER_TOKEN: GOOD,
    });

    expect(weak).toBe(
      "[operator-api] off: OPERATOR_API_TOKEN must be at least 32 characters long.",
    );
    expect(weak).not.toContain("weak-value");
    expect(reused).toBe(
      "[operator-api] off: OPERATOR_API_TOKEN must differ from RUNNER_TOKEN.",
    );
    expect(reused).not.toContain(GOOD);
  });

  // #275-T02
  it("logs the line through the logger it is given", () => {
    const log = vi.fn();

    logOperatorApiState({ OPERATOR_API_TOKEN: GOOD }, log);

    expect(log).toHaveBeenCalledExactlyOnceWith("[operator-api] on.");
  });
});
