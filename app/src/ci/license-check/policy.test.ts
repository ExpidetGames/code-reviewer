// SPDX-License-Identifier: Apache-2.0

// #118: license-policy.json against the real lockfiles. Which packages are installed differs per
// machine, so this reads only the lockfiles (the CI job and `make check-licenses` read the
// installed metadata).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkLicenses,
  describeViolation,
  findStalePolicyEntries,
  type LockedPackage,
} from "./check.ts";
import { parsePnpmLock, parseUvLock } from "./collect.ts";
import { matchesPackage, parsePolicy } from "./policy.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const policy = parsePolicy(JSON.parse(read("license-policy.json")));
const locked: LockedPackage[] = [
  ...parsePnpmLock(read("app/pnpm-lock.yaml")),
  ...parseUvLock(read("runner/uv.lock")),
];

describe("license-policy.json", () => {
  it("is valid and has no duplicate allowed license", () => {
    const ids = policy.allowed.map((id) => id.toLowerCase());

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads the lockfiles of both parts", () => {
    expect(
      locked.filter((entry) => entry.ecosystem === "npm").length,
    ).toBeGreaterThan(300);
    expect(
      locked.filter((entry) => entry.ecosystem === "python").length,
    ).toBeGreaterThan(100);
  });

  it("has no entry that matches no package of the lockfiles", () => {
    expect(
      findStalePolicyEntries(policy, locked).map(describeViolation),
    ).toEqual([]);
  });

  it("allows the license that it declares for every package that is not installed everywhere", () => {
    const declared: LockedPackage[] = policy.notInstalled.map((entry) => ({
      ecosystem: entry.ecosystem,
      name: entry.package.replace(/\*$/, "x"),
      version: "1.0.0",
    }));

    const result = checkLicenses({ policy, installed: [], locked: declared });

    expect(result.violations.map(describeViolation)).toEqual([]);
  });

  it("declares every package that the lockfiles list for another platform only by name pattern", () => {
    for (const entry of policy.notInstalled) {
      expect(
        locked.some(
          (candidate) =>
            candidate.ecosystem === entry.ecosystem &&
            matchesPackage(entry.ecosystem, entry.package, candidate.name),
        ),
        entry.package,
      ).toBe(true);
    }
  });
});
