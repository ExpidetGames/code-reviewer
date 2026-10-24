// SPDX-License-Identifier: LicenseRef-Proprietary

// #118: the license check against the policy, with made-up dependencies. The real policy and the
// real lockfiles are covered by policy.test.ts and by the CI job.
import { describe, expect, it } from "vitest";
import {
  checkLicenses,
  describeViolation,
  findStalePolicyEntries,
  type InstalledPackage,
  type LockedPackage,
} from "./check.ts";
import type { Policy } from "./policy.ts";

const policy: Policy = {
  allowed: ["MIT", "Apache-2.0", "BSD-3-Clause"],
  exceptions: [
    {
      ecosystem: "python",
      package: "html2text",
      licenses: ["GPL-3.0-only"],
      reason: "required by PR-Agent",
    },
    {
      ecosystem: "npm",
      package: "@img/sharp-*",
      licenses: ["LGPL-3.0-or-later"],
      reason: "prebuilt libvips",
    },
  ],
  notInstalled: [
    {
      ecosystem: "npm",
      package: "@next/swc-*",
      license: "MIT",
      reason: "binary per platform",
    },
    {
      ecosystem: "python",
      package: "colorama",
      license: "BSD-3-Clause",
      reason: "windows only",
    },
  ],
  binaries: [],
};

const npm = (
  name: string,
  license: string,
  version = "1.0.0",
): InstalledPackage => ({
  ecosystem: "npm",
  name,
  version,
  license,
});
const py = (
  name: string,
  license: string,
  version = "1.0.0",
): InstalledPackage => ({
  ecosystem: "python",
  name,
  version,
  license,
});
const locked = (installed: InstalledPackage[]): LockedPackage[] =>
  installed.map(({ ecosystem, name, version }) => ({
    ecosystem,
    name,
    version,
  }));

function run(
  installed: InstalledPackage[],
  options: { locked?: LockedPackage[]; policy?: Policy } = {},
) {
  return checkLicenses({
    policy: options.policy ?? policy,
    installed,
    locked: options.locked ?? locked(installed),
  });
}

describe("checkLicenses", () => {
  it("passes dependencies whose licenses are on the allow list", () => {
    const result = run([
      npm("a", "MIT"),
      py("b", "Apache-2.0 OR GPL-3.0-only"),
    ]);

    expect(result.violations).toEqual([]);
    expect(result.checked).toEqual({ npm: 1, python: 1, bun: 0 });
  });

  // #118-T01
  it("fails for a dependency with a copyleft license that is not on any list", () => {
    const result = run([npm("a", "MIT"), npm("copyleft-lib", "GPL-3.0-only")]);

    expect(result.violations.map(describeViolation)).toEqual([
      "LICENSE_NOT_ALLOWED: npm copyleft-lib@1.0.0 is GPL-3.0-only, which is not allowed",
    ]);
  });

  it("fails for AGPL, SSPL and a proprietary license alike", () => {
    const result = run([
      npm("a", "AGPL-3.0-or-later"),
      npm("b", "SSPL-1.0"),
      npm("c", "UNLICENSED"),
    ]);

    expect(result.violations).toHaveLength(3);
  });

  it("requires every part of an AND expression to be allowed", () => {
    const result = run([npm("a", "MIT AND GPL-3.0-only")]);

    expect(result.violations.map(describeViolation)).toEqual([
      "LICENSE_NOT_ALLOWED: npm a@1.0.0 is MIT AND GPL-3.0-only, which is not allowed (GPL-3.0-only)",
    ]);
  });

  it("allows an exception only for the package it names and only for the license it lists", () => {
    expect(run([py("html2text", "GPL-3.0-only")]).violations).toEqual([]);
    expect(run([py("other", "GPL-3.0-only")]).violations).toHaveLength(1);
    expect(run([py("html2text", "AGPL-3.0-only")]).violations).toHaveLength(1);
    expect(run([npm("html2text", "GPL-3.0-only")]).violations).toHaveLength(1);
  });

  it("matches the name of an exception that ends in a star as a prefix", () => {
    const result = run([
      npm("@img/sharp-libvips-linux-x64", "LGPL-3.0-or-later"),
      npm("@img/sharp-win32-x64", "Apache-2.0 AND LGPL-3.0-or-later"),
      npm("@img/other", "LGPL-3.0-or-later"),
    ]);

    expect(result.violations.map((violation) => violation.package)).toEqual([
      "@img/other",
    ]);
  });

  it("compares Python names the way PEP 503 does", () => {
    expect(run([py("HTML2Text", "GPL-3.0-only")]).violations).toEqual([]);
  });

  it("reports a license it cannot read", () => {
    const result = run([npm("a", "MIT AND")]);

    expect(result.violations.map((violation) => violation.code)).toEqual([
      "LICENSE_UNREADABLE",
    ]);
  });

  it("fails for a package that declares no license", () => {
    const result = run([py("giteapy", "NONE")]);

    expect(result.violations.map(describeViolation)).toEqual([
      "LICENSE_NOT_ALLOWED: python giteapy@1.0.0 is NONE, which is not allowed",
    ]);
  });

  // #202-T06
  describe("packages bundled in a prebuilt binary (ecosystem bun)", () => {
    const bun = (
      name: string,
      license: string,
      version = "1.0.0",
    ): InstalledPackage => ({ ecosystem: "bun", name, version, license });
    const withBunException: Policy = {
      ...policy,
      exceptions: [
        ...policy.exceptions,
        {
          ecosystem: "bun",
          package: "mpl-lib",
          licenses: ["MPL-2.0"],
          reason: "used unmodified",
        },
      ],
    };

    it("judges them like any other package and counts them", () => {
      const result = run([bun("a", "MIT"), bun("b", "GPL-3.0-only")]);

      expect(result.checked).toEqual({ npm: 0, python: 0, bun: 2 });
      expect(result.violations.map(describeViolation)).toEqual([
        "LICENSE_NOT_ALLOWED: bun b@1.0.0 is GPL-3.0-only, which is not allowed",
      ]);
    });

    it("fails for a package that declares no license or whose license could not be read", () => {
      const result = run([bun("a", "NONE"), bun("b", "UNRESOLVED")]);

      expect(result.violations.map((violation) => violation.package)).toEqual([
        "a",
        "b",
      ]);
    });

    it("allows an exception of the bun ecosystem only for bun packages", () => {
      expect(
        run([bun("mpl-lib", "MPL-2.0")], { policy: withBunException })
          .violations,
      ).toEqual([]);
      expect(
        run([npm("mpl-lib", "MPL-2.0")], { policy: withBunException })
          .violations,
      ).toHaveLength(1);
    });

    it("reports an exception for a package that is not in the snapshot as stale", () => {
      const packages = locked([bun("other", "MIT")]);

      expect(
        findStalePolicyEntries(withBunException, packages)
          .filter((entry) => entry.ecosystem === "bun")
          .map(describeViolation),
      ).toEqual([
        "STALE_EXCEPTION: bun mpl-lib matches no package in the lockfile; remove it from exceptions in license-policy.json",
      ]);
      expect(
        findStalePolicyEntries(
          withBunException,
          locked([bun("mpl-lib", "MPL-2.0")]),
        ).filter((entry) => entry.ecosystem === "bun"),
      ).toEqual([]);
    });
  });

  describe("packages of the lockfile that are not installed", () => {
    it("passes when the policy declares them and the declared license is allowed", () => {
      const result = run([npm("a", "MIT")], {
        locked: [
          ...locked([npm("a", "MIT")]),
          {
            ecosystem: "npm",
            name: "@next/swc-linux-x64-gnu",
            version: "16.0.0",
          },
          { ecosystem: "python", name: "colorama", version: "0.4.6" },
        ],
      });

      expect(result.violations).toEqual([]);
    });

    it("fails when nothing declares them, because their license cannot be read", () => {
      const result = run([npm("a", "MIT")], {
        locked: [
          ...locked([npm("a", "MIT")]),
          { ecosystem: "npm", name: "mystery-binding-win32", version: "1.0.0" },
        ],
      });

      expect(result.violations.map(describeViolation)).toEqual([
        "NOT_INSTALLED_UNDECLARED: npm mystery-binding-win32@1.0.0 is in the lockfile but not installed here, so its license cannot be read; add it to notInstalled in license-policy.json",
      ]);
    });

    it("fails when the declared license is not allowed", () => {
      const result = run([], {
        locked: [
          { ecosystem: "npm", name: "@next/swc-linux-x64-gnu", version: "1" },
        ],
        policy: {
          ...policy,
          notInstalled: [
            {
              ecosystem: "npm",
              package: "@next/swc-*",
              license: "GPL-3.0-only",
              reason: "x",
            },
          ],
        },
      });

      expect(result.violations.map((violation) => violation.code)).toEqual([
        "LICENSE_NOT_ALLOWED",
      ]);
    });

    it("compares Python versions the way PEP 440 does, so 2024.02.26 and 2024.2.26 are the same version", () => {
      const result = run([py("html2text", "GPL-3.0-only", "2024.02.26")], {
        locked: [
          { ecosystem: "python", name: "html2text", version: "2024.2.26" },
        ],
      });

      expect(result.violations).toEqual([]);
    });

    it("treats another installed version as not installed", () => {
      const result = run([npm("a", "MIT", "1.0.0")], {
        locked: [{ ecosystem: "npm", name: "a", version: "2.0.0" }],
      });

      expect(result.violations.map((violation) => violation.code)).toEqual([
        "NOT_INSTALLED_UNDECLARED",
      ]);
    });
  });

  describe("stale entries", () => {
    it("fails for an exception that matches no package, so exceptions do not outlive their dependency", () => {
      const packages = locked([npm("a", "MIT")]);

      expect(
        findStalePolicyEntries(policy, packages).map(describeViolation),
      ).toEqual([
        "STALE_EXCEPTION: python html2text matches no package in the lockfile; remove it from exceptions in license-policy.json",
        "STALE_EXCEPTION: npm @img/sharp-* matches no package in the lockfile; remove it from exceptions in license-policy.json",
        "STALE_NOT_INSTALLED_ENTRY: npm @next/swc-* matches no package in the lockfile; remove it from notInstalled in license-policy.json",
        "STALE_NOT_INSTALLED_ENTRY: python colorama matches no package in the lockfile; remove it from notInstalled in license-policy.json",
      ]);
    });

    it("finds nothing when every entry matches a package of the lockfile", () => {
      const packages: LockedPackage[] = [
        { ecosystem: "python", name: "html2text", version: "1" },
        { ecosystem: "npm", name: "@img/sharp-darwin-arm64", version: "1" },
        { ecosystem: "npm", name: "@next/swc-win32-x64-msvc", version: "1" },
        { ecosystem: "python", name: "colorama", version: "1" },
      ];

      expect(findStalePolicyEntries(policy, packages)).toEqual([]);
    });
  });
});
