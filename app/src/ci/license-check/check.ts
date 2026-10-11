// SPDX-License-Identifier: Apache-2.0

// The license check: every dependency of the lockfiles must carry a license from the allow list of
// license-policy.json, or one that the policy grants to that package by name. The inputs are plain
// data (the installed packages with their license expressions, the packages of the lockfiles), so
// the rules are tested without pnpm or uv; collect.ts and cli.ts gather the real data.
import {
  matchesPackage,
  normalizeName,
  type Ecosystem,
  type Policy,
} from "./policy.ts";
import { licenseIds, parseExpression, satisfies } from "./spdx.ts";

export type InstalledPackage = {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** The license as an SPDX expression (see python-license.ts for how Python gets there). */
  license: string;
};

export type LockedPackage = {
  ecosystem: Ecosystem;
  name: string;
  version: string | undefined;
};

export const VIOLATION_CODES = [
  "LICENSE_NOT_ALLOWED",
  "LICENSE_UNREADABLE",
  "NOT_INSTALLED_UNDECLARED",
  "STALE_EXCEPTION",
  "STALE_NOT_INSTALLED_ENTRY",
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export type Violation = {
  code: ViolationCode;
  ecosystem: Ecosystem;
  package: string;
  version?: string;
  license?: string;
  /** The license ids that are not allowed, for LICENSE_NOT_ALLOWED. */
  disallowed?: string[];
};

export type CheckResult = {
  violations: Violation[];
  /** How many installed packages were judged, per ecosystem. */
  checked: Record<Ecosystem, number>;
};

export function describeViolation(violation: Violation): string {
  const { code, ecosystem } = violation;
  const subject = violation.version
    ? `${violation.package}@${violation.version}`
    : violation.package;
  switch (code) {
    case "LICENSE_NOT_ALLOWED": {
      const only = violation.disallowed ?? [];
      const detail =
        only.length > 0 && only.join(" ") !== violation.license
          ? ` (${only.join(", ")})`
          : "";
      return `${code}: ${ecosystem} ${subject} is ${violation.license}, which is not allowed${detail}`;
    }
    case "LICENSE_UNREADABLE":
      return `${code}: ${ecosystem} ${subject} has the license ${JSON.stringify(violation.license)}, which is not an SPDX expression`;
    case "NOT_INSTALLED_UNDECLARED":
      return `${code}: ${ecosystem} ${subject} is in the lockfile but not installed here, so its license cannot be read; add it to notInstalled in license-policy.json`;
    case "STALE_EXCEPTION":
      return `${code}: ${ecosystem} ${subject} matches no package in the lockfile; remove it from exceptions in license-policy.json`;
    case "STALE_NOT_INSTALLED_ENTRY":
      return `${code}: ${ecosystem} ${subject} matches no package in the lockfile; remove it from notInstalled in license-policy.json`;
  }
}

function lower(id: string): string {
  return id.toLowerCase();
}

/** Judges one license expression for one package; null when it passes. */
function judge(
  policy: Policy,
  ecosystem: Ecosystem,
  name: string,
  license: string,
): Pick<Violation, "code" | "disallowed"> | null {
  const permitted = new Set(policy.allowed.map(lower));
  for (const exception of policy.exceptions) {
    if (
      exception.ecosystem === ecosystem &&
      matchesPackage(ecosystem, exception.package, name)
    ) {
      for (const id of exception.licenses) permitted.add(lower(id));
    }
  }
  let expression;
  try {
    expression = parseExpression(license);
  } catch {
    return { code: "LICENSE_UNREADABLE" };
  }
  const isPermitted = (id: string) => permitted.has(lower(id));
  if (satisfies(expression, isPermitted)) return null;
  return {
    code: "LICENSE_NOT_ALLOWED",
    disallowed: licenseIds(expression).filter((id) => !isPermitted(id)),
  };
}

export function checkLicenses(input: {
  policy: Policy;
  installed: InstalledPackage[];
  locked: LockedPackage[];
}): CheckResult {
  const { policy, installed, locked } = input;
  const violations: Violation[] = [];
  const checked: Record<Ecosystem, number> = { npm: 0, python: 0 };
  const installedKeys = new Set<string>();

  for (const entry of installed) {
    checked[entry.ecosystem] += 1;
    installedKeys.add(
      `${entry.ecosystem}:${normalizeName(entry.ecosystem, entry.name)}@${entry.version}`,
    );
    const problem = judge(policy, entry.ecosystem, entry.name, entry.license);
    if (problem) {
      violations.push({
        ...problem,
        ecosystem: entry.ecosystem,
        package: entry.name,
        version: entry.version,
        license: entry.license,
      });
    }
  }

  for (const entry of locked) {
    const key = `${entry.ecosystem}:${normalizeName(entry.ecosystem, entry.name)}@${entry.version}`;
    if (installedKeys.has(key)) continue;
    const declared = policy.notInstalled.find(
      (candidate) =>
        candidate.ecosystem === entry.ecosystem &&
        matchesPackage(entry.ecosystem, candidate.package, entry.name),
    );
    const base = {
      ecosystem: entry.ecosystem,
      package: entry.name,
      ...(entry.version === undefined ? {} : { version: entry.version }),
    };
    if (!declared) {
      violations.push({ ...base, code: "NOT_INSTALLED_UNDECLARED" });
      continue;
    }
    const problem = judge(
      policy,
      entry.ecosystem,
      entry.name,
      declared.license,
    );
    if (problem)
      violations.push({ ...base, ...problem, license: declared.license });
  }

  return { violations, checked };
}

/** Entries of the policy that match no package of the lockfiles. */
export function findStalePolicyEntries(
  policy: Policy,
  locked: LockedPackage[],
): Violation[] {
  const hasMatch = (ecosystem: Ecosystem, pattern: string) =>
    locked.some(
      (entry) =>
        entry.ecosystem === ecosystem &&
        matchesPackage(ecosystem, pattern, entry.name),
    );
  const stale: Violation[] = [];
  for (const entry of policy.exceptions) {
    if (!hasMatch(entry.ecosystem, entry.package)) {
      stale.push({
        code: "STALE_EXCEPTION",
        ecosystem: entry.ecosystem,
        package: entry.package,
      });
    }
  }
  for (const entry of policy.notInstalled) {
    if (!hasMatch(entry.ecosystem, entry.package)) {
      stale.push({
        code: "STALE_NOT_INSTALLED_ENTRY",
        ecosystem: entry.ecosystem,
        package: entry.package,
      });
    }
  }
  return stale;
}
