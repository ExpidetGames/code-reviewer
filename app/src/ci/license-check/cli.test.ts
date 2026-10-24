// SPDX-License-Identifier: LicenseRef-Proprietary

// #118: the command that the CI job runs, with made-up data instead of pnpm and uv.
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.ts";
import type { Collected } from "./collect.ts";
import type { Policy } from "./policy.ts";

const policy: Policy = {
  allowed: ["MIT", "Apache-2.0"],
  exceptions: [],
  notInstalled: [],
  binaries: [],
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

  // #202-T06
  describe("with prebuilt binaries in the policy", () => {
    const commit = "733b2c627e5aec39cb33cc22373bdce33053ef2c";
    const digest = "c".repeat(64);
    const binaryPolicy: Policy = {
      ...policy,
      binaries: [
        {
          name: "opencode",
          pin: "runner/opencode-pin.json",
          version: "1.19.0",
          commit,
          license: "MIT",
          bundledLicenses: "runner/bundled.json",
          reason: "the engine",
        },
      ],
    };
    const document = `Package: OpenCode 1.19.0 at ${commit}, runner/bundled.json`;

    function files(bundledLicense: string): Record<string, string> {
      return {
        "runner/opencode-pin.json": JSON.stringify({
          repository: "https://github.com/anomalyco/opencode",
          version: "1.19.0",
          commit,
          license: "MIT",
          licenseUrl:
            "https://github.com/anomalyco/opencode/blob/v1.19.0/LICENSE",
          platforms: {
            "linux-x64": { archiveSha256: digest, executableSha256: digest },
          },
        }),
        "runner/bundled.json": JSON.stringify({
          sourceCommit: commit,
          packages: [
            { name: "left-pad", version: "1.0.0", license: bundledLicense },
          ],
        }),
        "THIRD_PARTY_LICENSES.md": document,
        NOTICE: document,
      };
    }

    function runWith(known: Record<string, string>) {
      const out: string[] = [];
      const err: string[] = [];
      const exitCode = runCli({
        policy: binaryPolicy,
        collect: () => collected("MIT"),
        readText: (path) => known[path],
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      });
      return { exitCode, out, err };
    }

    it("exits 0 and reports the binaries and the bundled packages it checked", () => {
      const result = runWith(files("MIT"));

      expect(result.err).toEqual([]);
      expect(result.exitCode).toBe(0);
      expect(result.out.join("\n")).toContain(
        "1 npm and 1 python packages installed",
      );
      expect(result.out.join("\n")).toContain(
        "1 binary pin(s) and 1 package(s) bundled in them",
      );
    });

    it("exits 1 when a pin file is missing", () => {
      const known = files("MIT");
      delete known["runner/opencode-pin.json"];

      const result = runWith(known);

      expect(result.exitCode).toBe(1);
      expect(result.err.join("\n")).toContain(
        "BINARY_PIN_UNREADABLE: opencode: runner/opencode-pin.json cannot be read",
      );
    });

    it("exits 1 when a package bundled in a binary has a license outside the policy", () => {
      const result = runWith(files("AGPL-3.0-only"));

      expect(result.exitCode).toBe(1);
      expect(result.err.join("\n")).toContain(
        "LICENSE_NOT_ALLOWED: bun left-pad@1.0.0 is AGPL-3.0-only",
      );
    });

    it("exits 1 when the documents do not mention the binary", () => {
      const known = { ...files("MIT"), NOTICE: "nothing" };

      const result = runWith(known);

      expect(result.exitCode).toBe(1);
      expect(result.err.join("\n")).toContain("BINARY_NOT_DOCUMENTED: NOTICE");
    });
  });
});
