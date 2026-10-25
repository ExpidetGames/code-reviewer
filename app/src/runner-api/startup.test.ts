// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the start-up hint about the runner token: it names the problem, once, and never the token.
import { describe, expect, it } from "vitest";
import { runnerTokenWarning, warnAboutRunnerToken } from "./startup.ts";

describe("the runner token at start", () => {
  it("says nothing for a token of 32 characters or more", () => {
    expect(runnerTokenWarning({ RUNNER_TOKEN: "a".repeat(32) })).toBeNull();
  });

  it.each([
    ["not set", undefined],
    ["blank", "   "],
    ["too short", "a".repeat(31)],
    ["split by a space", `${"a".repeat(20)} ${"a".repeat(20)}`],
  ])(
    "warns that every call is refused when the token is %s",
    (_name, token) => {
      expect(runnerTokenWarning({ RUNNER_TOKEN: token })).toContain("refused");
    },
  );

  it("does not repeat the token in its warning", () => {
    const line = runnerTokenWarning({ RUNNER_TOKEN: "short-secret-value" });

    expect(line).not.toContain("short-secret-value");
  });

  it("logs one line, or none", () => {
    const lines: string[] = [];

    warnAboutRunnerToken({ RUNNER_TOKEN: "a".repeat(40) }, (l) =>
      lines.push(l),
    );
    expect(lines).toStrictEqual([]);
    warnAboutRunnerToken({}, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
  });
});
