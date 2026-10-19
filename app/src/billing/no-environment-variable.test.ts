// SPDX-License-Identifier: Apache-2.0

// Billing is configured in the admin portal and in nothing else (ADR 0006): no environment variable, so
// `.env.example` and the deployment files stay as they are for a self-hoster.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("billing and the environment", () => {
  // #437-T10
  it("adds no variable to .env.example", () => {
    const names = readFileSync(join(ROOT, ".env.example"), "utf8")
      .split("\n")
      .map((line) => /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
      .filter((name) => name !== undefined);

    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /BILLING|STRIPE/.test(name))).toEqual([]);
  });

  // #437-T10
  it("reads no BILLING or STRIPE variable in the billing module", () => {
    const sources = readdirSync(import.meta.dirname).filter(
      (name) => /\.tsx?$/.test(name) && !/\.test\./.test(name),
    );

    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources)
      expect(
        readFileSync(join(import.meta.dirname, file), "utf8"),
        file,
      ).not.toMatch(
        /process\.env\.(BILLING|STRIPE)|env\[\s*["'`](BILLING|STRIPE)/,
      );
  });
});
