// Pins down that the server refuses to start with an incomplete sign in configuration: one readable
// line with the code and the variable names, exit code 1, and never a secret in that line.
import { describe, expect, it, vi } from "vitest";
import { checkAuthConfigOnStart } from "./startup.ts";

const validEnv = {
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_OAUTH_CLIENT_ID: "id",
  GITHUB_OAUTH_CLIENT_SECRET: "secret-value",
  ALLOWED_GITHUB_LOGINS: "octocat",
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

  // CR-19-T03
  it("warns once, clearly, when nobody is on the allow list, and still starts", () => {
    const exit = vi.fn();
    const log = vi.fn();
    const warn = vi.fn();
    const withoutList = { ...validEnv, ALLOWED_GITHUB_LOGINS: undefined };

    checkAuthConfigOnStart({ env: withoutList, log, warn, exit });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("ALLOWED_GITHUB_LOGINS");
    expect(line).toContain("ALLOWED_GITHUB_ORG");
    expect(line).toContain("nobody");
    expect(line).not.toContain("\n");
  });

  it("does not warn when a list or an organization is set", () => {
    for (const env of [
      validEnv,
      {
        ...validEnv,
        ALLOWED_GITHUB_LOGINS: undefined,
        ALLOWED_GITHUB_ORG: "o",
      },
    ]) {
      const warn = vi.fn();

      checkAuthConfigOnStart({ env, log: vi.fn(), warn, exit: vi.fn() });

      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("warns once about allow-list entries that cannot be logins, without echoing long values", () => {
    const warn = vi.fn();
    const long = `@${"x".repeat(60)}`;

    checkAuthConfigOnStart({
      env: { ...validEnv, ALLOWED_GITHUB_LOGINS: `octocat,@hubot,${long}` },
      log: vi.fn(),
      warn,
      exit: vi.fn(),
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("ACCESS_LIST_ENTRY_INVALID");
    expect(line).toContain("ALLOWED_GITHUB_LOGINS");
    expect(line).toContain("@hubot");
    expect(line).not.toContain(long);
    expect(line).not.toContain("\n");
  });

  // CR-42-T09 (adjusted: an invalid login:id entry is ignored with a warning, the start goes on)
  it.each(["octocat:", ":1001", "octocat:abc", "octocat:10:20", "octocat:-5"])(
    "warns once about the invalid login:id entry %j, without its text, and still starts",
    (entry) => {
      const warn = vi.fn();
      const log = vi.fn();
      const exit = vi.fn();

      checkAuthConfigOnStart({
        env: {
          ...validEnv,
          ALLOWED_GITHUB_LOGINS: `hubot, ${entry} ,octocat2:7`,
        },
        log,
        warn,
        exit,
      });

      expect(exit).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain("ACCESS_LIST_ENTRY_INVALID");
      expect(line).toContain("ALLOWED_GITHUB_LOGINS");
      expect(line).toContain("login:id");
      expect(line).not.toContain(entry);
      expect(line).not.toContain("1001");
      expect(line).not.toContain("\n");
    },
  );

  // CR-42-T09
  it.each(["octocat:1001", "OctoCat:1001", "  octocat:1001  "])(
    "starts without a warning for the valid entry %j",
    (entry) => {
      const warn = vi.fn();
      const exit = vi.fn();

      checkAuthConfigOnStart({
        env: { ...validEnv, ALLOWED_GITHUB_LOGINS: `hubot,${entry}` },
        log: vi.fn(),
        warn,
        exit,
      });

      expect(exit).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  // CR-42-T13
  it("names invalid plain entries but never the text of an invalid login:id entry", () => {
    const warn = vi.fn();

    checkAuthConfigOnStart({
      env: { ...validEnv, ALLOWED_GITHUB_LOGINS: "@hubot,mallory:7x7" },
      log: vi.fn(),
      warn,
      exit: vi.fn(),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("@hubot");
    expect(line).not.toContain("777");
    expect(line).not.toContain("7x7");
    expect(line).not.toContain("mallory");
  });
});
