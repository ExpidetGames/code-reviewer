// SPDX-License-Identifier: Apache-2.0

// Pins down that the server refuses to start with an incomplete sign in configuration: one readable
// line with the code and the variable names, exit code 1, and never a secret in that line.
import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { parseAccessConfig } from "./access-config.ts";
import { checkAuthConfigOnStart, syncLoginPinsOnStart } from "./startup.ts";

const validEnv = {
  APP_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
};

describe("the allow list variables of the earlier sign in", () => {
  // #102-GH-ALLOW-LIST
  it.each([
    ["ALLOWED_GITHUB_LOGINS", "octocat,hubot"],
    ["ALLOWED_GITHUB_ORG", "acme"],
  ])(
    "warns once that %s is ignored, without printing its value",
    (name, value) => {
      const warn = vi.fn();
      const exit = vi.fn();

      checkAuthConfigOnStart({
        env: { ...validEnv, [name]: value },
        log: vi.fn(),
        warn,
        exit,
      });

      expect(exit).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain("ALLOWED_GITHUB_LOGINS");
      expect(line).toContain("ALLOWED_GITHUB_ORG");
      expect(line).toMatch(/ignored/i);
      expect(line).toMatch(/sign-up rule/i);
      expect(line).not.toContain(value);
      expect(line).not.toContain("\n");
    },
  );

  // #102-GH-ALLOW-LIST
  it("warns once, not twice, when both are set", () => {
    const warn = vi.fn();

    checkAuthConfigOnStart({
      env: {
        ...validEnv,
        ALLOWED_GITHUB_LOGINS: "octocat",
        ALLOWED_GITHUB_ORG: "acme",
      },
      log: vi.fn(),
      warn,
      exit: vi.fn(),
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  // #102-GH-ALLOW-LIST
  it("says nothing when they are unset, empty or blank", () => {
    const warn = vi.fn();

    checkAuthConfigOnStart({
      env: { ...validEnv, ALLOWED_GITHUB_LOGINS: "", ALLOWED_GITHUB_ORG: "  " },
      log: vi.fn(),
      warn,
      exit: vi.fn(),
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

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
  it("starts without any GITHUB_ variable and without an allow list warning", () => {
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

describe("bringing the login bindings in line with the list when the server starts", () => {
  // A database that fails on first contact, and says so with a message full of values.
  const brokenDb = {
    selectFrom: () => {
      throw new Error("database is locked (octocat, 1001)");
    },
    transaction: () => {
      throw new Error("database is locked (octocat, 1001)");
    },
    insertInto: () => {
      throw new Error("database is locked (octocat, 1001)");
    },
    deleteFrom: () => {
      throw new Error("database is locked (octocat, 1001)");
    },
  } as unknown as Kysely<Database>;

  // CR-42 (failure path)
  it("ends the start with exit code 1 and one line that names no login and no id when the bindings cannot be updated", async () => {
    const log = vi.fn<(message: string) => void>();
    const exit = vi.fn<(code: number) => void>();
    const info = vi.fn<(message: string) => void>();

    await syncLoginPinsOnStart({
      db: brokenDb,
      config: parseAccessConfig(
        { ALLOWED_GITHUB_LOGINS: "octocat:1001,hubot" },
        [],
      ),
      info,
      log,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("LOGIN_PINS_SYNC_FAILED");
    expect(line).not.toMatch(/octocat|hubot|1001|locked/);
    expect(line).not.toContain("\n");
    expect(info).not.toHaveBeenCalled();
  });

  // CR-42-T12
  it.each([
    ["only an organization", { ALLOWED_GITHUB_ORG: "my-org" }],
    ["nothing", {}],
    ["only invalid entries", { ALLOWED_GITHUB_LOGINS: "octocat:abc" }],
  ])(
    "does not touch the database at all with %s configured",
    async (_case, env) => {
      const log = vi.fn<(message: string) => void>();
      const exit = vi.fn<(code: number) => void>();

      await syncLoginPinsOnStart({
        db: brokenDb,
        config: parseAccessConfig(env, []),
        log,
        exit,
      });

      expect(exit).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );
});
