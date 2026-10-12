// SPDX-License-Identifier: Apache-2.0

// Pins down that the server refuses to start with an incomplete sign in configuration: one readable
// line with the code and the variable names, exit code 1, and never a secret in that line.
import { describe, expect, it, vi } from "vitest";
import { checkAuthConfigOnStart } from "./startup.ts";

const validEnv = {
  APP_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
};

describe("checking the sign in configuration when the server starts", () => {
  it("lets a complete configuration start", () => {
    const exit = vi.fn();
    const log = vi.fn();

    checkAuthConfigOnStart({ env: validEnv, log, exit });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  // #97-SU-17
  it("stops the start with one line that names what is missing", () => {
    const exit = vi.fn();
    const log = vi.fn();

    checkAuthConfigOnStart({
      env: {
        ...validEnv,
        APP_SECRET: undefined,
        BETTER_AUTH_URL: "",
      },
      log,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("AUTH_CONFIG_INVALID");
    expect(line).toContain("APP_SECRET");
    expect(line).toContain("BETTER_AUTH_URL");
    expect(line).not.toContain("\n");
  });

  // #97-SU-17
  it("starts without any GITHUB_ variable and without a warning", () => {
    const exit = vi.fn();
    const log = vi.fn();
    const warn = vi.fn();

    checkAuthConfigOnStart({
      env: {
        APP_SECRET: "x".repeat(40),
        BETTER_AUTH_URL: "https://reviews.example.com",
        NODE_ENV: "production",
      },
      log,
      warn,
      exit,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  // #97-SU-17
  it("warns once, naming both variables and no value, when APP_SECRET and BETTER_AUTH_SECRET differ", () => {
    const warn = vi.fn();
    const exit = vi.fn();
    const other = "other-".padEnd(40, "o");

    checkAuthConfigOnStart({
      env: { ...validEnv, BETTER_AUTH_SECRET: other },
      log: vi.fn(),
      warn,
      exit,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("APP_SECRET");
    expect(line).toContain("BETTER_AUTH_SECRET");
    expect(line).not.toContain(other);
    expect(line).not.toContain("x".repeat(40));
  });

  // #97-SU-17
  it("starts with only BETTER_AUTH_SECRET and logs the deprecation once, without the value", () => {
    const exit = vi.fn();
    const warn = vi.fn();
    const secret = "legacy-".padEnd(40, "l");

    checkAuthConfigOnStart({
      env: {
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: "http://localhost:3000",
      },
      log: vi.fn(),
      warn,
      exit,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("BETTER_AUTH_SECRET");
    expect(line).toContain("deprecated");
    expect(line).not.toContain(secret);
  });
});
