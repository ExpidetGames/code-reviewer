// SPDX-License-Identifier: Apache-2.0

// The text files of the repository that git tracks or would track (not ignored), for the scans of the whole tree.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** Paths relative to the repository root, sorted; binary files are left out. */
export function listTrackedFiles(repoRoot: string): string[] {
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(listing.split("\0"))]
    .filter((path) => path !== "" && existsSync(`${repoRoot}/${path}`))
    .filter((path) => !readFileSync(`${repoRoot}/${path}`).includes(0))
    .sort();
}
