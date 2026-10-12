// SPDX-License-Identifier: Apache-2.0

// Pins down that a production server refuses to start without the settings a deployment needs
// besides sign in (the runner token): one readable line with the code and the variable names, exit
// code 1, and never a value in that line. The GitHub App is not required: the instance starts
// without any GITHUB_ variable. Development servers are left alone.
import { describe, expect, it, vi } from "vitest";
import {
  configuredRunnerToken,
  tokensMatch,
} from "../runner-api/token-auth.ts";
import {
  checkDeploymentConfigOnStart,
  findDeploymentConfigProblems,
} from "./startup.ts";

const validEnv = {
  NODE_ENV: "production",
  RUNNER_TOKEN: "r".repeat(40),
};

async function run(env: Record<string, string | undefined>) {
  const exit = vi.fn();
  const log = vi.fn();
  await checkDeploymentConfigOnStart({ env, log, exit });
  return { exit, log };
}

describe("checking the deployment settings when the server starts", () => {
  it("lets a complete configuration start", async () => {
    const { exit, log } = await run(validEnv);

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  // CR-37-T08
  it("stops the start with one line naming the missing runner token", async () => {
    const { exit, log } = await run({ ...validEnv, RUNNER_TOKEN: undefined });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("DEPLOY_CONFIG_INVALID");
    expect(line).toContain("RUNNER_TOKEN");
    expect(line).not.toContain("\n");
  });

  // CR-37-T08
  it("rejects a runner token that is too short to be a secret", async () => {
    const { exit, log } = await run({ ...validEnv, RUNNER_TOKEN: "short" });

    expect(exit).toHaveBeenCalledWith(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("RUNNER_TOKEN");
    expect(line).toContain("at least 32 characters");
  });

  // CR-37-T08
  it("judges the runner token exactly as the runner API does, white space around it included", async () => {
    const tokens = [
      "x".repeat(31),
      "x".repeat(32),
      `${"x".repeat(32)}\n`,
      `${"x".repeat(31)}\n`,
      `  ${"x".repeat(32)}  `,
      `${"x".repeat(20)} ${"x".repeat(20)}`,
      `${"x".repeat(40)}\u0007`,
      "   ",
      "",
    ];

    for (const token of tokens) {
      const usable = tokensMatch(
        configuredRunnerToken({ RUNNER_TOKEN: token }),
        token.trim(),
      );
      const problems = findDeploymentConfigProblems({
        ...validEnv,
        RUNNER_TOKEN: token,
      });

      expect(
        problems.some((problem) => problem.includes("RUNNER_TOKEN")),
        JSON.stringify(token),
      ).toBe(!usable);
    }
  });

  // CR-37-T09
  it("never prints a value of any setting", async () => {
    const { log } = await run({
      ...validEnv,
      RUNNER_TOKEN: "short-secret-token",
    });

    const line = String(log.mock.calls[0]?.[0]);
    expect(line).not.toContain("short-secret-token");
  });

  it("does not check anything outside production so that the dev server starts", async () => {
    const { exit, log } = await run({ NODE_ENV: "development" });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
