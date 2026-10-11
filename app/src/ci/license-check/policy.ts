// SPDX-License-Identifier: Apache-2.0

// The license policy of the repository: license-policy.json at the repository root. One file holds
// the allow list and every documented exception, so the CI check, its tests and
// THIRD_PARTY_LICENSES.md (which a test compares with this file) read the same facts.
import { z } from "zod";

export const ECOSYSTEMS = ["npm", "python"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

const ecosystem = z.enum(ECOSYSTEMS);
const nonEmpty = z.string().min(1);

export const policySchema = z.strictObject({
  /** SPDX ids that may appear in any dependency, compared without regard to case. */
  allowed: z.array(nonEmpty).min(1),
  /**
   * Packages that may carry a license outside the allow list. `package` is an exact name or a name
   * ending in `*`. `licenses` are the ids that these packages may add to the allow list, nothing else.
   */
  exceptions: z.array(
    z.strictObject({
      ecosystem,
      package: nonEmpty,
      licenses: z.array(nonEmpty).min(1),
      reason: nonEmpty,
    }),
  ),
  /**
   * Packages that the lockfile lists but that are not installed on every machine (a binary for
   * another operating system, a wasm fallback, a dependency for another platform), so their license
   * cannot be read from installed metadata. `license` is what the registry says, read when the entry
   * was added; it is judged like any other license.
   */
  notInstalled: z.array(
    z.strictObject({
      ecosystem,
      package: nonEmpty,
      license: nonEmpty,
      reason: nonEmpty,
    }),
  ),
});

export type Policy = z.infer<typeof policySchema>;

export function parsePolicy(json: unknown): Policy {
  return policySchema.parse(json);
}

/** Python names are compared the way PEP 503 normalizes them; npm names are exact. */
export function normalizeName(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "python"
    ? name.toLowerCase().replace(/[-_.]+/g, "-")
    : name;
}

/** An exact package name, or a prefix ending in `*`. */
export function matchesPackage(
  ecosystem: Ecosystem,
  pattern: string,
  name: string,
): boolean {
  const wanted = normalizeName(ecosystem, pattern.replace(/\*$/, ""));
  const actual = normalizeName(ecosystem, name);
  return pattern.endsWith("*") ? actual.startsWith(wanted) : actual === wanted;
}
