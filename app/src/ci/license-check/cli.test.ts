// SPDX-License-Identifier: Apache-2.0

// #118: the command that the CI job runs, with made-up data instead of pnpm and uv.
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.ts";
import type { Collected } from "./collect.ts";
import type { Policy } from "./policy.ts";

const policy: Policy = {
  allowed: ["MIT", "Apache-2.0"],
  exceptions: [],
  notInstalled: [],
};

function collected(license: string): Collected {
  return {
    installed: [
      { ecosystem: "npm", name: "left-pad", version: "1.0.0", license: "MIT" },
      { ecosystem: "python", name: "lib", version: "2.0.0", license },
    ],
    locked: [
      { ecosystem: "npm", name: "left-pad", version: "1.0.0" },
      { ecosystem: "python", name: "lib", version: "2.0.0" },
    ],
  };
}

function run(data: Collected) {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = runCli({
    policy,
    collect: () => data,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { exitCode, out, err };
}

describe("runCli", () => {
  // #118-T01
  it("exits 0 and reports what it checked when every license is allowed", () => {
    const result = run(collected("Apache-2.0"));

    expect(result.exitCode).toBe(0);
    expect(result.out.join("\n")).toContain("1 npm and 1 python");
    expect(result.err).toEqual([]);
  });

  // #118-T01
  it("exits 1 and names the package and the license when a copyleft license is not allowed", () => {
    const result = run(collected("AGPL-3.0-only"));

    expect(result.exitCode).toBe(1);
    expect(result.err.join("\n")).toContain(
      "LICENSE_NOT_ALLOWED: python lib@2.0.0 is AGPL-3.0-only",
    );
  });

  it("exits 1 when a collector could not run, instead of passing with nothing checked", () => {
    const out: string[] = [];
    const err: string[] = [];
    const exitCode = runCli({
      policy,
      collect: () => {
        throw new Error("PNPM_LICENSES_UNREADABLE: not JSON");
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("PNPM_LICENSES_UNREADABLE");
  });
});
