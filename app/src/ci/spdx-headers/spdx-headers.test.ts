// SPDX-License-Identifier: Apache-2.0

// #118: every source file of the repository starts with the SPDX license header. The rules (which
// files count, in which comment syntax) are in rules.ts; `make fix-spdx-headers` writes the headers
// that are missing. This test reads the real files that git tracks or would track, so a new file
// without the header fails here, in CI and in `make verify`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findHeader, SPDX_IDENTIFIER } from "./rules.ts";
import { listSourceFiles } from "./source-files.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const files = listSourceFiles(repoRoot);

describe("SPDX license headers", () => {
  it("covers the source files of every part of the repository, and none of the data or generated files", () => {
    expect(files.length).toBeGreaterThan(300);
    for (const path of [
      "app/src/ci/spdx-headers/rules.ts",
      "app/src/ui/button.tsx",
      "app/src/app/globals.css",
      "app/next.config.ts",
      "runner/src/code_reviewer_runner/cli.py",
      "runner/scripts/list_licenses.py",
      "fakes/github/server.ts",
      "docker/smoke/lib.sh",
      "app/Dockerfile",
      "runner/Dockerfile",
      "Makefile",
    ]) {
      expect(files, path).toContain(path);
    }
    for (const path of files) {
      expect(path, path).not.toMatch(
        /\.(json|ya?ml|toml|md|lock)$|^docs\/|^fakes\/fixtures\/|next-env\.d\.ts$/,
      );
    }
  });

  // #118-T04
  it("start every source file with SPDX-License-Identifier: Apache-2.0", () => {
    const without = files.filter(
      (path) =>
        findHeader(readFileSync(`${repoRoot}${path}`, "utf8")) !==
        SPDX_IDENTIFIER,
    );

    expect(
      without,
      "source files without the header (run: make fix-spdx-headers)",
    ).toEqual([]);
  });
});
