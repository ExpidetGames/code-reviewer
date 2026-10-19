// SPDX-License-Identifier: Apache-2.0

// #436-T11: the billing module reads credentials and talks to the payment provider, so it must never reach a browser bundle.
// Every source file of the module carries the `server-only` marker (Next.js fails the build when a client
// component imports a file that has it), and no client component may import the module, directly or through
// another file. The scan reads the real source tree.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("..", import.meta.url));
const billingRoot = join(srcRoot, "billing");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const isTest = (path: string) => /\.test\.tsx?$/.test(path);

const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

/** The files a source file imports, as absolute paths (relative and `@/` imports only). */
function importsOf(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(IMPORT)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier === undefined) continue;
    if (specifier.startsWith("@/"))
      found.push(join(srcRoot, specifier.slice(2)));
    else if (specifier.startsWith("."))
      found.push(resolve(dirname(path), specifier));
  }
  return found;
}

describe("the billing module is server-only", () => {
  // #436-T11
  it("marks every source file of the module with the server-only import", () => {
    const files = sourceFiles(billingRoot).filter((path) => !isTest(path));
    expect(files.length).toBeGreaterThan(0);
    for (const path of files)
      expect(readFileSync(path, "utf8"), path).toMatch(
        /^import "server-only";$/m,
      );
  });

  // #436-T11
  it("is imported by no client component, directly or through another file", () => {
    const all = sourceFiles(srcRoot).filter((path) => !isTest(path));
    const clients = all.filter((path) =>
      /^\s*["']use client["']/.test(readFileSync(path, "utf8")),
    );
    const reaches = (start: string): string | null => {
      const seen = new Set<string>();
      const walk = (path: string): string | null => {
        if (seen.has(path)) return null;
        seen.add(path);
        for (const target of importsOf(path)) {
          if (target === billingRoot || target.startsWith(`${billingRoot}/`))
            return target;
          const file = all.find(
            (candidate) =>
              candidate === target ||
              candidate.replace(/\.(ts|tsx)$/, "") === target,
          );
          if (file !== undefined) {
            const found = walk(file);
            if (found !== null) return found;
          }
        }
        return null;
      };
      return walk(start);
    };
    for (const client of clients) expect(reaches(client), client).toBeNull();
  });
});
