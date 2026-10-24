// SPDX-License-Identifier: LicenseRef-Proprietary

// The source files of the repository: what git tracks or would track (not ignored), filtered by the
// rules. Shared by the check (spdx-headers.test.ts) and the command that writes the headers.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isSourceFile } from "./rules.ts";

/** Paths relative to the repository root, sorted. */
export function listSourceFiles(repoRoot: string): string[] {
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return (
    [...new Set(listing.split("\0"))]
      .filter((path) => path !== "" && isSourceFile(path))
      // Listed by git but deleted in the working tree (not staged yet).
      .filter((path) => existsSync(`${repoRoot}/${path}`))
      .sort()
  );
}
