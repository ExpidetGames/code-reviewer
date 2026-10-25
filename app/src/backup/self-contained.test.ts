// SPDX-License-Identifier: LicenseRef-Proprietary

// The backup command line is a folder of its own: the image copies only `src/backup`
// (app/Dockerfile) and runs `node backup/cli.ts` without Next.js. A value import that leaves this
// folder would break the image with ERR_MODULE_NOT_FOUND, which is exactly the bug a Postgres-URL
// check imported from `../db/` caused. Type-only imports are fine: they are erased.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backupDir = fileURLToPath(new URL("./", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!path.endsWith(".ts") || path.endsWith(".test.ts")) return [];
    return [path];
  });
}

/** Every module a file imports as a value: `from "..."` and `import("...")`, but not `import type`. */
function valueImports(source: string): string[] {
  const names: string[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const from = /from\s+["']([^"']+)["']/.exec(line);
    if (from?.[1]) {
      let start = index;
      while (start > 0 && !/^\s*import\b/.test(lines[start] ?? "")) start -= 1;
      const statement = lines.slice(start, index + 1).join(" ");
      if (!/^\s*import\s+type\b/.test(statement)) names.push(from[1]);
    }
    for (const match of line.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g))
      if (match[1]) names.push(match[1]);
  }
  return names;
}

describe("the backup module is a folder of its own", () => {
  // #105-PG-01 (the image runs this folder alone)
  it("imports no value from outside src/backup", () => {
    const escaping: string[] = [];
    for (const file of sourceFiles(backupDir)) {
      for (const importPath of valueImports(readFileSync(file, "utf8"))) {
        if (!importPath.startsWith(".")) continue;
        const target = resolve(file, "..", importPath);
        if (relative(backupDir, target).startsWith(".."))
          escaping.push(`${relative(backupDir, file)} -> ${importPath}`);
      }
    }

    expect(escaping).toEqual([]);
  });
});
