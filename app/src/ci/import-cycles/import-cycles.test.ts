// SPDX-License-Identifier: LicenseRef-Proprietary

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_IMPORT_CYCLES } from "./allow-list.ts";
import {
  buildFileGraph,
  checkImportCycles,
  checkMigrationIsolation,
  checkProductIdentityImports,
  cyclicGroups,
  moduleOf,
  readFileGraph,
  type AllowList,
} from "./graph.ts";

const NOTHING_ALLOWED: AllowList = { fileGroups: [], moduleEdges: [] };

// The samples are built, not written as import lines: this file is itself scanned for imports.
const imports = (...specifiers: string[]) =>
  specifiers.map((specifier) => `import "${specifier}";`).join("\n");

function graphOf(files: Record<string, string>) {
  return buildFileGraph(new Map(Object.entries(files)));
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function sourceTree(files: Record<string, string>): string {
  const src = mkdtempSync(join(tmpdir(), "import-cycles-"));
  directories.push(src);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(src, dirname(path)), { recursive: true });
    writeFileSync(join(src, path), content);
  }
  return src;
}

describe("the import cycle check", () => {
  // #715-T01
  it("fails for a cycle between files that is not on the allow-list", () => {
    const graph = graphOf({
      "a/one.ts": imports("./two.ts"),
      "a/two.ts": imports("./three.ts"),
      "a/three.ts": imports("./one.ts"),
      "a/free.ts": imports("./one.ts"),
    });

    const problems = checkImportCycles(graph, NOTHING_ALLOWED);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("new import cycle between files (3 files");
    expect(problems[0]).toContain("a/one.ts -> a/two.ts -> a/three.ts");
    expect(cyclicGroups(graph)).toEqual([
      ["a/one.ts", "a/three.ts", "a/two.ts"],
    ]);
  });

  // #715-T01
  it("fails when a new import joins two listed cycles into one", () => {
    const allowed: AllowList = {
      fileGroups: [
        ["a/one.ts", "a/two.ts"],
        ["b/one.ts", "b/two.ts"],
      ],
      moduleEdges: ["a -> b", "b -> a"],
    };
    const separate = graphOf({
      "a/one.ts": imports("./two.ts"),
      "a/two.ts": imports("./one.ts"),
      "b/one.ts": imports("./two.ts"),
      "b/two.ts": imports("./one.ts"),
    });
    expect(checkImportCycles(separate, allowed)).toEqual([
      expect.stringContaining("a -> b is on the module cycle allow-list"),
      expect.stringContaining("b -> a is on the module cycle allow-list"),
    ]);

    const joined = graphOf({
      "a/one.ts": imports("./two.ts"),
      "a/two.ts": imports("./one.ts", "../b/one.ts"),
      "b/one.ts": imports("./two.ts"),
      "b/two.ts": imports("./one.ts", "../a/one.ts"),
    });
    expect(checkImportCycles(joined, allowed)).toEqual([
      expect.stringContaining("new import cycle between files (4 files"),
    ]);
  });

  // #715-T01
  it("fails for a new import between modules that already form a cycle, and for a new module cycle", () => {
    const allowed: AllowList = {
      fileGroups: [],
      moduleEdges: ["a -> b", "b -> a"],
    };
    const graph = graphOf({
      "a/x.ts": imports("../b/x.ts"),
      "b/x.ts": imports("../a/y.ts"),
      "a/y.ts": "export {};",
      "b/y.ts": imports("../c/x.ts"),
      "c/x.ts": imports("../b/z.ts"),
      "b/z.ts": "export {};",
    });

    expect(checkImportCycles(graph, allowed)).toEqual([
      "new import between modules that already depend on each other: b -> c (for example b/y.ts -> c/x.ts)",
      "new import between modules that already depend on each other: c -> b (for example c/x.ts -> b/z.ts)",
    ]);
  });

  // #715-T02
  it("fails for an allow-list entry that is no longer a cycle, so the list can only shrink", () => {
    const allowed: AllowList = {
      fileGroups: [["a/one.ts", "a/two.ts"]],
      moduleEdges: ["a -> b", "b -> a"],
    };
    const graph = graphOf({
      "a/one.ts": imports("./two.ts", "../b/one.ts"),
      "a/two.ts": "export {};",
      "b/one.ts": "export {};",
    });

    expect(checkImportCycles(graph, allowed)).toEqual([
      "a/one.ts is on the file cycle allow-list but is no longer in a cycle: remove it from fileGroups",
      "a/two.ts is on the file cycle allow-list but is no longer in a cycle: remove it from fileGroups",
      "a -> b is on the module cycle allow-list but is no longer on a cycle: remove it from moduleEdges",
      "b -> a is on the module cycle allow-list but is no longer on a cycle: remove it from moduleEdges",
    ]);
  });

  it("passes when the cycles are exactly the allowed ones", () => {
    const graph = graphOf({
      "a/one.ts": imports("./two.ts", "../b/one.ts"),
      "a/two.ts": imports("./one.ts"),
      "b/one.ts": imports("../a/two.ts"),
    });
    expect(
      checkImportCycles(graph, {
        fileGroups: [["a/one.ts", "a/two.ts", "b/one.ts"]],
        moduleEdges: ["a -> b", "b -> a"],
      }),
    ).toEqual([]);
  });

  it("reads the imports of production code: aliases, relative paths, index files, type-only, dynamic and re-exports", () => {
    const src = sourceTree({
      "a/main.ts": [
        imports("@/b/one.ts"),
        'import type { T } from "../c";',
        'export { x } from "./sibling";',
        'const lazy = () => import("../d/lazy.js");',
        'import "server-only";',
        'import styles from "./styles.css";',
        '// import "../ignored/in-comment.ts";',
      ].join("\n"),
      "a/sibling.ts": "export const x = 1;",
      "b/one.ts": "export {};",
      "c/index.ts": "export type T = string;",
      "d/lazy.ts": "export {};",
      "ignored/in-comment.ts": "export {};",
      "a/main.test.ts": imports("../b/only-tests.ts"),
      "b/only-tests.ts": "export {};",
      "test-support/helper.ts": imports("../a/main.ts"),
      "a/view.tsx": imports("./sibling.ts"),
    });

    const graph = readFileGraph(src);

    expect([...(graph.get("a/main.ts") ?? [])].sort()).toEqual([
      "a/sibling.ts",
      "b/one.ts",
      "c/index.ts",
      "d/lazy.ts",
    ]);
    expect([...(graph.get("a/view.tsx") ?? [])]).toEqual(["a/sibling.ts"]);
    expect([...graph.keys()]).not.toContain("a/main.test.ts");
    expect([...graph.keys()]).not.toContain("test-support/helper.ts");
  });

  it("treats a file directly in src as a module of its own", () => {
    expect(moduleOf("billing/hold.ts")).toBe("billing");
    expect(moduleOf("proxy.ts")).toBe("proxy.ts");
  });
});

describe("the isolation of the frozen migrations", () => {
  // #715-T04
  it("fails for a migration that imports application code, but not for its own folder and the shared leaf files", () => {
    const graph = graphOf({
      "db/migrations/2026_a.ts": imports(
        "./helper.ts",
        "./support/rules.ts",
        "../codecs.ts",
        "../driver.ts",
      ),
      "db/migrations/helper.ts": imports("../../llm/config.ts"),
      "db/migrations/support/rules.ts": imports("../../../model-catalog/x.ts"),
      "db/migrations/2026_b.ts": imports("../repositories/jobs-repository.ts"),
      "db/codecs.ts": "export {};",
      "db/driver.ts": "export {};",
      "db/repositories/jobs-repository.ts": "export {};",
      "llm/config.ts": "export {};",
      "model-catalog/x.ts": "export {};",
    });

    expect(checkMigrationIsolation(graph)).toEqual([
      expect.stringContaining(
        "db/migrations/2026_b.ts imports db/repositories/jobs-repository.ts: a migration is frozen",
      ),
      expect.stringContaining(
        "db/migrations/helper.ts imports llm/config.ts: a migration is frozen",
      ),
      expect.stringContaining(
        "db/migrations/support/rules.ts imports model-catalog/x.ts: a migration is frozen",
      ),
    ]);
  });

  // #715-T04
  it("fails for any file outside db/migrations that imports the support folder", () => {
    const graph = graphOf({
      "db/migrations/support/rules.ts": "export {};",
      "db/migrations/2026_a.ts": imports("./support/rules.ts"),
      "llm/config.ts": imports("../db/migrations/support/rules.ts"),
      "db/repositories/x.ts": imports("../migrations/support/rules.ts"),
    });

    expect(checkMigrationIsolation(graph)).toEqual([
      expect.stringContaining(
        "db/repositories/x.ts imports db/migrations/support/rules.ts",
      ),
      expect.stringContaining(
        "llm/config.ts imports db/migrations/support/rules.ts",
      ),
    ]);
  });

  // #715-T04
  it("holds for the migrations of app/src", () => {
    const src = join(import.meta.dirname, "..", "..");

    expect(checkMigrationIsolation(readFileGraph(src))).toEqual([]);
  });
});

describe("the import cycles of app/src", () => {
  // #715-T01 #715-T02 #715-T03
  it("are exactly the ones on the allow-list", () => {
    const src = join(import.meta.dirname, "..", "..");

    expect(
      checkImportCycles(readFileGraph(src), ALLOWED_IMPORT_CYCLES),
    ).toEqual([]);
  });
});

describe("the brand", () => {
  // #715-T08
  it("is imported only by the selector, and the type of the identity imports nothing", () => {
    const graph = graphOf({
      "product-identity/identity.ts": imports("../copy/messages.ts"),
      "product-identity/code-review-com.ts": imports("./identity.ts"),
      "product-identity/current.ts": imports(
        "./code-review-com.ts",
        "./identity.ts",
      ),
      "copy/messages.ts": "export {};",
      "mail/invite.ts": imports("../product-identity/code-review-com.ts"),
      "mail/shared.ts": imports("../product-identity/code-review-com.ts"),
      "app/login/page.tsx": imports(
        "../../product-identity/code-review-com.ts",
      ),
      "auth/auth.ts": imports("../product-identity/current.ts"),
      "billing/send.ts": imports("../product-identity/identity.ts"),
    });

    expect(checkProductIdentityImports(graph)).toEqual([
      expect.stringContaining(
        "app/login/page.tsx imports product-identity/code-review-com.ts: get the identity from getProductIdentity()",
      ),
      expect.stringContaining(
        "mail/invite.ts imports product-identity/code-review-com.ts: get the identity from getProductIdentity()",
      ),
      expect.stringContaining(
        "mail/shared.ts imports product-identity/code-review-com.ts: get the identity from getProductIdentity()",
      ),
      expect.stringContaining(
        "product-identity/identity.ts imports copy/messages.ts: the type of the identity imports nothing",
      ),
    ]);
  });

  // #715-T08
  it("holds for app/src", () => {
    const src = join(import.meta.dirname, "..", "..");

    expect(checkProductIdentityImports(readFileGraph(src))).toEqual([]);
  });
});
