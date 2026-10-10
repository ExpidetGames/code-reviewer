// Pins down that a production server refuses to start without the settings a deployment needs
// besides sign in (runner token and GitHub App credentials): one readable line with the code and
// the variable names, exit code 1, and never a value in that line. Development servers are left
// alone so that the sign in can be tried without a GitHub App.
import { describe, expect, it, vi } from "vitest";
import { checkDeploymentConfigOnStart } from "./startup.ts";

const validEnv = {
  NODE_ENV: "production",
  RUNNER_TOKEN: "r".repeat(40),
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "code-reviewer",
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value",
  GITHUB_APP_PRIVATE_KEY: "private-key-value",
};

function run(env: Record<string, string | undefined>) {
  const exit = vi.fn();
  const log = vi.fn();
  checkDeploymentConfigOnStart({ env, log, exit });
  return { exit, log };
}

describe("checking the deployment settings when the server starts", () => {
  it("lets a complete configuration start", () => {
    const { exit, log } = run(validEnv);

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  // CR-37-T08
  it("stops the start with one line naming the missing runner token", () => {
    const { exit, log } = run({ ...validEnv, RUNNER_TOKEN: undefined });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("DEPLOY_CONFIG_INVALID");
    expect(line).toContain("RUNNER_TOKEN");
    expect(line).not.toContain("\n");
  });

  it("treats an empty or blank value like a missing one", () => {
    const { exit, log } = run({ ...validEnv, GITHUB_APP_ID: "   " });

    expect(exit).toHaveBeenCalledWith(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("GITHUB_APP_ID");
  });

  it("names every missing GitHub App setting in the same line", () => {
    const { exit, log } = run({
      NODE_ENV: "production",
      RUNNER_TOKEN: validEnv.RUNNER_TOKEN,
    });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    for (const name of [
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
    ]) {
      expect(line).toContain(name);
    }
  });

  it("accepts the private key as a file path instead of inline", () => {
    const { exit } = run({
      ...validEnv,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_PRIVATE_KEY_PATH: "/run/secrets/github-app.pem",
    });

    expect(exit).not.toHaveBeenCalled();
  });

  // CR-37-T08
  it("rejects a runner token that is too short to be a secret", () => {
    const { exit, log } = run({ ...validEnv, RUNNER_TOKEN: "short" });

    expect(exit).toHaveBeenCalledWith(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("RUNNER_TOKEN");
    expect(line).toContain("at least 32 characters");
  });

  // CR-37-T09
  it("never prints a value of any setting", () => {
    const { log } = run({
      ...validEnv,
      RUNNER_TOKEN: "short-secret-token",
      GITHUB_APP_SLUG: undefined,
    });

    const line = String(log.mock.calls[0]?.[0]);
    expect(line).not.toContain("short-secret-token");
    expect(line).not.toContain(validEnv.GITHUB_APP_ID);
    expect(line).not.toContain(validEnv.GITHUB_APP_WEBHOOK_SECRET);
    expect(line).not.toContain(validEnv.GITHUB_APP_PRIVATE_KEY);
  });

  it("does not check anything outside production so that the dev server starts without a GitHub App", () => {
    const { exit, log } = run({ NODE_ENV: "development" });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
