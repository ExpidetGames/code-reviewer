// SPDX-License-Identifier: LicenseRef-Proprietary

// `pnpm setup-code` (#321) without a database: what it refuses before it touches anything, and, with a
// stand-in for the database, where the code goes. The code is shown on the terminal of the operator and
// nowhere else; the run against a real database is in setup-code-cli.integration.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runSetupCodeCommand,
  SETUP_CODE_CLI_ERROR_CODES,
  type SetupCodeBackend,
} from "./setup-code-cli.ts";

const SECRET = "cli-secret-0123456789-0123456789-0123456789";
const CODE = "482913";
const ENV = {
  APP_RUNTIME: "serverless",
  APP_SECRET: SECRET,
  DATABASE_URL_MIGRATE: "postgres://app:s3cr3t-pw@db.example.test/app",
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
  };
}

function backend(overrides: Partial<SetupCodeBackend> = {}) {
  const calls = { issue: 0, closed: 0 };
  const value: SetupCodeBackend = {
    schemaCurrent: () => Promise.resolve(true),
    isSetUp: () => Promise.resolve(false),
    issue: () => {
      calls.issue += 1;
      return Promise.resolve({
        code: CODE,
        issueId: "a".repeat(32),
        expiresAt: new Date("2026-10-15T09:00:00.000Z"),
      });
    },
    close: () => {
      calls.closed += 1;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { value, calls };
}

function run(
  env: Record<string, string | undefined>,
  stand: ReturnType<typeof backend>,
  options: { isTerminal?: boolean; allowPipe?: boolean } = {},
) {
  const r = recorder();
  const exit = vi.spyOn(process, "exit");
  const consoleCalls: unknown[][] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  return {
    ...r,
    exit,
    consoleCalls,
    code: runSetupCodeCommand(env, r.io, {
      isTerminal: options.isTerminal ?? true,
      allowPipe: options.allowPipe ?? false,
      open: () => Promise.resolve(stand.value),
    }),
  };
}

describe("pnpm setup-code", () => {
  // #321-T05
  it("prints the code on the output of the terminal, once, with its expiry, and nowhere else", async () => {
    const stand = backend();
    const result = run(ENV, stand);

    expect(await result.code).toBe(0);

    expect(result.out.filter((line) => line.includes(CODE))).toHaveLength(1);
    expect(result.out.join("\n")).toContain("2026-10-15T09:00:00.000Z");
    expect(result.err).toEqual([]);
    expect(JSON.stringify(result.consoleCalls)).not.toContain(CODE);
    expect(stand.calls.closed).toBe(1);
    expect(result.exit).not.toHaveBeenCalled();
  });

  // #321-T05
  it("refuses to print the code when the output is not a terminal (a build log, a pipe), and creates none", async () => {
    const stand = backend();
    const result = run(ENV, stand, { isTerminal: false });

    expect(await result.code).toBe(1);

    expect(stand.calls.issue).toBe(0);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain("SETUP_CODE_NOT_A_TERMINAL");
    expect(result.err.join("\n")).not.toContain(CODE);
  });

  // #321-T05
  it("prints to a pipe only when the operator asks for it", async () => {
    const stand = backend();
    const result = run(ENV, stand, { isTerminal: false, allowPipe: true });

    expect(await result.code).toBe(0);

    expect(result.out.join("\n")).toContain(CODE);
    expect(result.err).toEqual([]);
  });

  // #321-T05
  it("never repeats the cause of a failure, which could carry the code or a connection string", async () => {
    const stand = backend({
      issue: () =>
        Promise.reject(
          new Error(`insert failed for ${CODE} on postgres://app:s3cr3t-pw@db`),
        ),
    });
    const result = run(ENV, stand);

    expect(await result.code).toBe(1);

    const text = [...result.out, ...result.err].join("\n");
    expect(text).toContain("SETUP_CODE_FAILED");
    expect(text).not.toContain(CODE);
    expect(text).not.toContain("s3cr3t-pw");
    expect(JSON.stringify(result.consoleCalls)).not.toContain(CODE);
    expect(stand.calls.closed).toBe(1);
  });

  // #321-T04
  it("refuses in server mode, where the code is printed by the app itself, and writes nothing", async () => {
    const stand = backend();
    const result = run({ ...ENV, APP_RUNTIME: "server" }, stand);

    expect(await result.code).toBe(1);

    expect(stand.calls.issue).toBe(0);
    expect(result.err.join("\n")).toContain("SETUP_CODE_NOT_SERVERLESS");
    expect(result.err.join("\n")).toContain("APP_RUNTIME=serverless");
  });

  // #321-T04
  it("refuses with a message about APP_RUNTIME when it is not set and the platform marker is absent", async () => {
    const stand = backend();
    const result = run({ ...ENV, APP_RUNTIME: undefined }, stand);

    expect(await result.code).toBe(1);
    expect(result.err.join("\n")).toContain("SETUP_CODE_NOT_SERVERLESS");
  });

  // #321-T05
  it("names the variable, never a value, when APP_SECRET is missing or short", async () => {
    for (const secret of [undefined, "short-secret-1234"]) {
      const stand = backend();
      const result = run({ ...ENV, APP_SECRET: secret }, stand);

      expect(await result.code).toBe(1);

      expect(stand.calls.issue).toBe(0);
      expect(result.err.join("\n")).toContain("SETUP_CODE_CONFIG_INVALID");
      expect(result.err.join("\n")).toContain("APP_SECRET");
      expect(result.err.join("\n")).not.toContain("short-secret-1234");
    }
  });

  // #321-T06
  it("refuses when the instance is already set up", async () => {
    const stand = backend({ isSetUp: () => Promise.resolve(true) });
    const result = run(ENV, stand);

    expect(await result.code).toBe(1);

    expect(stand.calls.issue).toBe(0);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain("SETUP_ALREADY_DONE");
    expect(stand.calls.closed).toBe(1);
  });

  // #321-T06
  it("refuses while the schema is behind, and says to run pnpm migrate", async () => {
    const stand = backend({ schemaCurrent: () => Promise.resolve(false) });
    const result = run(ENV, stand);

    expect(await result.code).toBe(1);

    expect(stand.calls.issue).toBe(0);
    expect(result.err.join("\n")).toContain("SETUP_CODE_SCHEMA_BEHIND");
    expect(result.err.join("\n")).toContain("pnpm migrate");
  });

  // #321-T05
  it("fails with one line and no connection string when the database cannot be opened", async () => {
    const r = recorder();

    const code = await runSetupCodeCommand(ENV, r.io, {
      isTerminal: true,
      allowPipe: false,
      open: () =>
        Promise.reject(
          new Error("connect failed for postgres://app:s3cr3t-pw@db"),
        ),
    });

    expect(code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain("SETUP_CODE_FAILED");
    expect(r.err.join("\n")).not.toContain("s3cr3t-pw");
  });

  it("has a stable set of error codes", () => {
    expect([...SETUP_CODE_CLI_ERROR_CODES].sort()).toEqual([
      "SETUP_ALREADY_DONE",
      "SETUP_CODE_CONFIG_INVALID",
      "SETUP_CODE_FAILED",
      "SETUP_CODE_NOT_A_TERMINAL",
      "SETUP_CODE_NOT_SERVERLESS",
      "SETUP_CODE_SCHEMA_BEHIND",
    ]);
  });
});
