// SPDX-License-Identifier: LicenseRef-Proprietary

// The steps of the deployment that sign in to Infisical and write to it run with the client secret in their
// environment (#403). They load nothing from the package registry: every module they import, directly or through
// another file of this folder, is one of ours or a Node built-in, so no dependency, pinned or not, ever sees the
// secret. The platform SDK is imported only inside `createService` of `ops-main.ts`, when a cleanup needs it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The specifiers of the `import ... from "x"` and `export ... from "x"` of a source text, type-only ones left out. */
export function valueImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+"([^"]+)";/gm,
  ))
    specifiers.push(match[1] as string);
  for (const match of source.matchAll(/^import\s+"([^"]+)";/gm))
    specifiers.push(match[1] as string);
  return specifiers;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    for (const specifier of valueImports(source))
      if (specifier.startsWith("./")) walk(specifier.slice(2));
  };
  walk(entry);
  return seen;
}

describe("the imports of the steps that write to Infisical", () => {
  // #403-T19
  it("are our own modules and Node built-ins, from the entry file down", () => {
    const files = reachable("ops-main.ts");
    // The entry and what it reaches: the commands, the clients and the pair, and not the pipeline.
    expect([...files]).toContain("infisical.ts");
    expect([...files]).toContain("ops-cli.ts");
    expect([...files]).not.toContain("pipeline.ts");
    for (const file of files)
      for (const specifier of valueImports(
        readFileSync(join(import.meta.dirname, file), "utf8"),
      ))
        expect(
          specifier.startsWith("./") || specifier.startsWith("node:"),
          `${file} imports ${specifier}`,
        ).toBe(true);
  });

  // #403-T19
  it("see a package import, a multi-line one and a re-export, and not a type-only one", () => {
    const source = [
      'import { z } from "zod";',
      'import type { A } from "type-only";',
      'import {\n  a,\n  b,\n} from "multi-line";',
      'export { c } from "re-export";',
      'import "side-effect";',
      'import { d } from "node:fs";',
    ].join("\n");

    expect(valueImports(source)).toEqual([
      "zod",
      "multi-line",
      "re-export",
      "node:fs",
      "side-effect",
    ]);
  });
});
