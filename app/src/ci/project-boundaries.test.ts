// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { importsOf, violationsIn } from "./project-boundaries.ts";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === ".next" || name === "dist")
      continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) found.push(path);
  }
  return found;
}

function existing(directory: string): string[] {
  try {
    return sourceFiles(directory);
  } catch {
    return [];
  }
}

// The samples are built, not written as import lines: this file is itself scanned for imports.
const named = (specifier: string) =>
  `import x from ${JSON.stringify(specifier)};`;
const typed = (specifier: string) =>
  `import type { B } from ${JSON.stringify(specifier)};`;
const reexport = (specifier: string) =>
  `export { c } from ${JSON.stringify(specifier)};`;
const dynamic = (specifier: string) =>
  `const d = await import(${JSON.stringify(specifier)});`;
const required = (specifier: string) =>
  `const e = require(${JSON.stringify(specifier)});`;
const bare = (specifier: string) => `import ${JSON.stringify(specifier)};`;

describe("the project boundaries", () => {
  // #318-T07
  it("find every way a file can import another project's source", () => {
    const source = [
      named("../../../app/src/jobs/queue.ts"),
      typed("../../../app/src/db/types"),
      reexport("../../../runner/src/x"),
      dynamic("../../../app/src/y.ts"),
      required("../../../app/src/z"),
      bare("../../../app/src/side-effect"),
      named("code-reviewer-app/src/h"),
    ].join("\n");

    expect(importsOf(source)).toHaveLength(7);
    expect(
      violationsIn("dispatcher/src/core/claim.ts", source, "dispatcher").map(
        (v) => v.specifier,
      ),
    ).toStrictEqual([
      "../../../app/src/jobs/queue.ts",
      "../../../app/src/db/types",
      "../../../runner/src/x",
      "../../../app/src/y.ts",
      "../../../app/src/z",
      "../../../app/src/side-effect",
      "code-reviewer-app/src/h",
    ]);
  });

  // #318-T07
  it("allow the project's own files, its packages, contracts, generated types and the fakes", () => {
    const source = [
      named("./local.ts"),
      named("../contracts/worker-api.ts"),
      named("hono"),
      named("node:crypto"),
      named("../../../fakes/dispatcher-app/server.ts"),
      named("../../../contracts/examples/ClaimResponse.json"),
    ].join("\n");

    expect(
      violationsIn("dispatcher/src/core/claim.ts", source, "dispatcher"),
    ).toStrictEqual([]);
  });

  // #318-T07
  it("refuse a path that climbs out of the project into a sibling", () => {
    expect(
      violationsIn(
        "dispatcher/src/index.ts",
        named("../../app/package.json"),
        "dispatcher",
      ),
    ).toHaveLength(1);
  });

  // #318-T07
  it("hold for the Dispatcher project in the repository (nothing under app/ or runner/)", () => {
    const files = existing(join(REPOSITORY, "dispatcher"));
    const violations = files.flatMap((file) =>
      violationsIn(
        relative(REPOSITORY, file),
        readFileSync(file, "utf8"),
        "dispatcher",
      ),
    );

    expect(violations).toStrictEqual([]);
  });

  // #318-T07
  it("hold for the app (nothing under dispatcher/ or runner/)", () => {
    const files = existing(join(REPOSITORY, "app", "src")).concat(
      existing(join(REPOSITORY, "app", "integration-tests")),
    );
    const violations = files.flatMap((file) =>
      violationsIn(
        relative(REPOSITORY, file),
        readFileSync(file, "utf8"),
        "app",
      ),
    );

    expect(violations).toStrictEqual([]);
  });
});
