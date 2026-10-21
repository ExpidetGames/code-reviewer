// SPDX-License-Identifier: Apache-2.0

// #505-T13: the billing page of a workspace is made of client components, so none of its files may carry a colour literal (every
// colour is a token of theme.css) or reach server-only code: the database, the billing module, the secrets. The scan reads the real
// source files of this folder; the general guards (`ci/colors`, `billing/server-only.test.ts`) cover the whole tree as well.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanColors } from "../ci/colors/rules.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const srcRoot = resolve(here, "..");

function sourcesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourcesIn(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

const files = sourcesIn(here);

const IMPORT =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const FORBIDDEN = [
  "billing",
  "db",
  "secrets",
  "auth",
  "jobs",
  "runner-api",
  "dispatch",
];

describe("the files of the workspace billing page", () => {
  it("has files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  // #505-T13
  it("carry no colour literal", () => {
    const found = scanColors(
      files.map((path) => ({
        path: `app/src/${path.slice(srcRoot.length + 1)}`,
        content: readFileSync(path, "utf8"),
      })),
    );

    expect(found).toEqual([]);
  });

  // #505-T13
  it("import no server-only code and carry no server-only marker", () => {
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(/^import "server-only";$/m);
      for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2];
        if (specifier === undefined || !specifier.startsWith(".")) continue;
        const target = resolve(dirname(path), specifier).slice(
          srcRoot.length + 1,
        );
        const folder = target.split("/")[0] ?? "";
        expect(FORBIDDEN, `${path} imports ${specifier}`).not.toContain(folder);
      }
    }
  });
});
