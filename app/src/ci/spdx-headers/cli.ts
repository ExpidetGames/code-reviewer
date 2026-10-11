// SPDX-License-Identifier: Apache-2.0

// Adds or checks the SPDX license header of the source files. Run from app/:
//
//   node src/ci/spdx-headers/cli.ts --write    add the header to every source file that lacks it
//   node src/ci/spdx-headers/cli.ts --check    list the source files without it (exit code 1)
//
// (`pnpm spdx:add`, `pnpm spdx:check`, `make fix-spdx-headers`.) Writing is idempotent and only
// touches files that lack the header, so it can be run again at any time, for example after a merge
// brought in files from a branch that predates the rule. What counts as a source file is in
// rules.ts.
//
// Node runs this file as it is (TypeScript types are stripped): relative imports with the .ts
// extension and no TypeScript-only runtime syntax.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addHeader, commentStyle, findHeader } from "./rules.ts";
import { listSourceFiles } from "./source-files.ts";

const USAGE = "Usage: node src/ci/spdx-headers/cli.ts --write | --check";

type Streams = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export function runCli(
  args: readonly string[],
  repoRoot: string,
  { out, err }: Streams,
): number {
  const [mode] = args;
  if (args.length !== 1 || (mode !== "--write" && mode !== "--check")) {
    err(USAGE);
    return 2;
  }
  const missing = listSourceFiles(repoRoot).filter(
    (path) => findHeader(readFileSync(`${repoRoot}/${path}`, "utf8")) === null,
  );
  if (mode === "--check") {
    for (const path of missing) err(`missing SPDX header: ${path}`);
    if (missing.length > 0) {
      err(`${missing.length} file(s) lack the header; run: pnpm spdx:add`);
      return 1;
    }
    out("Every source file has the SPDX header.");
    return 0;
  }
  for (const path of missing) {
    const style = commentStyle(path);
    if (style === null) continue;
    const file = `${repoRoot}/${path}`;
    writeFileSync(file, addHeader(readFileSync(file, "utf8"), style));
    out(path);
  }
  out(`Added the header to ${missing.length} file(s).`);
  return 0;
}

// Runs only when started as the program, not when a test imports `runCli`.
if (import.meta.main) {
  const repoRoot = fileURLToPath(
    new URL("../../../../", import.meta.url),
  ).replace(/\/$/, "");
  process.exitCode = runCli(process.argv.slice(2), repoRoot, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
