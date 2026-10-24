// SPDX-License-Identifier: LicenseRef-Proprietary

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CORE = import.meta.dirname;

function importsOf(source: string): string[] {
  return [
    ...source.matchAll(
      /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? "");
}

describe("the Dispatcher core", () => {
  // #327 (additional): the core is platform-free
  it("imports no Node module, no platform SDK and no web framework", () => {
    const files = readdirSync(CORE).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    const imports = files.flatMap((file) =>
      importsOf(readFileSync(join(CORE, file), "utf8")).map(
        (specifier) => `${file}: ${specifier}`,
      ),
    );

    expect(files.length).toBeGreaterThan(0);
    expect(
      imports.filter((entry) => /: (node:|@vercel\/|@hono\/|hono)/.test(entry)),
    ).toStrictEqual([]);
  });
});
