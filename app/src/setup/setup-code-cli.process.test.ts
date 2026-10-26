// SPDX-License-Identifier: LicenseRef-Proprietary

// `pnpm setup-code` as the real program under plain Node, the way the script in package.json starts it
// (#321): its refusals reach the right stream with the right exit code. Nothing here reaches a database.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "setup-code-cli.ts");
const SECRET = "process-secret-0123456789-0123456789-0123";

function runProgram(env: Record<string, string>, args: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      CLI,
      ...args,
    ],
    // Only what the test names: nothing from the developer's environment can reach a database.
    {
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
      encoding: "utf8",
    },
  );
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("the setup-code program", () => {
  // #321-T05
  it("refuses to print to a pipe, before it connects to anything", () => {
    const result = runProgram({
      APP_SECRET: SECRET,
      DATABASE_URL_MIGRATE: "postgres://app:s3cr3t-pw@127.0.0.1:1/app",
    });

    expect(result.status).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("SETUP_CODE_NOT_A_TERMINAL");
    expect(result.err).not.toContain("s3cr3t-pw");
  });

  // #321-T05
  it("with --allow-pipe fails on an unreachable database with one line, never the password", () => {
    const result = runProgram(
      {
        APP_SECRET: SECRET,
        DATABASE_URL_MIGRATE: "postgres://app:s3cr3t-pw@127.0.0.1:1/app",
      },
      ["--allow-pipe"],
    );

    expect(result.status).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("SETUP_CODE_FAILED");
    expect(result.err).not.toContain("s3cr3t-pw");
    expect(result.err).not.toMatch(/\d{6}/);
  });
});
