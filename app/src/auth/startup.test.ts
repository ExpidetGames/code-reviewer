// Pins down that the server refuses to start with an incomplete sign in configuration: one readable
// line with the code and the variable names, exit code 1, and never a secret in that line.
import { describe, expect, it, vi } from "vitest";
import { checkAuthConfigOnStart } from "./startup.ts";

const validEnv = {
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_OAUTH_CLIENT_ID: "id",
  GITHUB_OAUTH_CLIENT_SECRET: "secret-value",
};

describe("checking the sign in configuration when the server starts", () => {
  it("lets a complete configuration start", () => {
    const exit = vi.fn();
    const log = vi.fn();

    checkAuthConfigOnStart({ env: validEnv, log, exit });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("stops the start with one line that names what is missing", () => {
    const exit = vi.fn();
    const log = vi.fn();

    checkAuthConfigOnStart({
      env: {
        ...validEnv,
        BETTER_AUTH_SECRET: undefined,
        GITHUB_OAUTH_CLIENT_SECRET: "",
      },
      log,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("AUTH_CONFIG_INVALID");
    expect(line).toContain("BETTER_AUTH_SECRET");
    expect(line).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(line).not.toContain("\n");
  });
});
