// SPDX-License-Identifier: LicenseRef-Proprietary

// #118: the readers of what pnpm and uv print and of the lockfiles. The real files are read in
// policy.test.ts.
import { describe, expect, it } from "vitest";
import {
  parsePnpmLicenses,
  parsePnpmLock,
  parsePythonInstalled,
  parseUvLock,
  UV_LICENSES_ARGS,
  withoutFirstParty,
} from "./collect.ts";

describe("parsePnpmLicenses", () => {
  it("flattens the groups of `pnpm licenses list --json` into one entry per name and version", () => {
    const output = JSON.stringify({
      MIT: [{ name: "left-pad", versions: ["1.3.0", "1.2.0"], license: "MIT" }],
      "Apache-2.0": [{ name: "@scope/pkg", versions: ["2.0.0"] }],
    });

    expect(parsePnpmLicenses(output)).toEqual([
      { ecosystem: "npm", name: "left-pad", version: "1.3.0", license: "MIT" },
      { ecosystem: "npm", name: "left-pad", version: "1.2.0", license: "MIT" },
      {
        ecosystem: "npm",
        name: "@scope/pkg",
        version: "2.0.0",
        license: "Apache-2.0",
      },
    ]);
  });

  it("fails on output that is not the expected shape, instead of checking nothing", () => {
    expect(() => parsePnpmLicenses("[]")).toThrow("PNPM_LICENSES_UNREADABLE");
    expect(() => parsePnpmLicenses("not json")).toThrow(
      "PNPM_LICENSES_UNREADABLE",
    );
  });
});

describe("parsePnpmLock", () => {
  it("reads the name and version of every package, scoped names included", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "packages:",
      "  '@img/sharp-win32-x64@0.35.5':",
      "    resolution: {integrity: sha512-x}",
      "  left-pad@1.3.0:",
      "    resolution: {integrity: sha512-y}",
      "snapshots:",
      "  left-pad@1.3.0: {}",
    ].join("\n");

    expect(parsePnpmLock(lock)).toEqual([
      { ecosystem: "npm", name: "@img/sharp-win32-x64", version: "0.35.5" },
      { ecosystem: "npm", name: "left-pad", version: "1.3.0" },
    ]);
  });

  it("fails on a lockfile without packages", () => {
    expect(() => parsePnpmLock("lockfileVersion: '9.0'\n")).toThrow(
      "PNPM_LOCK_UNREADABLE",
    );
  });
});

describe("parseUvLock", () => {
  it("reads the name and version of every package", () => {
    const lock = [
      "version = 1",
      "",
      "[[package]]",
      'name = "annotated-types"',
      'version = "0.8.0"',
      'source = { registry = "https://pypi.org/simple" }',
      "",
      "[[package]]",
      'name = "code-reviewer-runner"',
      'version = "0.1.0"',
      'source = { editable = "." }',
    ].join("\n");

    expect(parseUvLock(lock)).toEqual([
      { ecosystem: "python", name: "annotated-types", version: "0.8.0" },
      { ecosystem: "python", name: "code-reviewer-runner", version: "0.1.0" },
    ]);
  });

  it("fails on a lockfile without packages", () => {
    expect(() => parseUvLock("version = 1\n")).toThrow("UV_LOCK_UNREADABLE");
  });
});

describe("parsePythonInstalled", () => {
  it("turns the metadata of the packages into license expressions", () => {
    const output = JSON.stringify([
      {
        name: "a",
        version: "1",
        expression: "MIT",
        license: null,
        classifiers: [],
      },
      {
        name: "b",
        version: "2",
        expression: null,
        license: "Apache 2.0",
        classifiers: [],
      },
    ]);

    expect(parsePythonInstalled(output)).toEqual([
      { ecosystem: "python", name: "a", version: "1", license: "MIT" },
      { ecosystem: "python", name: "b", version: "2", license: "Apache-2.0" },
    ]);
  });

  it("fails on output that is not the expected shape, instead of checking nothing", () => {
    expect(() => parsePythonInstalled("{}")).toThrow(
      "PYTHON_LICENSES_UNREADABLE",
    );
  });
});

describe("the uv command", () => {
  // #118-T02
  it("never syncs the environment, so the check cannot install packages or use the network", () => {
    expect(UV_LICENSES_ARGS).toContain("--no-sync");
    expect(UV_LICENSES_ARGS).toContain("--locked");
  });
});

describe("withoutFirstParty", () => {
  // #677: the runner is our own proprietary package; its license is no business of the allow list.
  it("drops the runner package under any spelling of its name and keeps every dependency", () => {
    const packages = [
      { ecosystem: "python" as const, name: "Code_Reviewer.Runner" },
      { ecosystem: "python" as const, name: "pr-agent" },
      { ecosystem: "npm" as const, name: "code-reviewer-runner" },
    ];

    expect(withoutFirstParty(packages).map((entry) => entry.name)).toEqual([
      "pr-agent",
      "code-reviewer-runner",
    ]);
  });
});
