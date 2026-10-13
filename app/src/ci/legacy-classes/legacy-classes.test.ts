// SPDX-License-Identifier: Apache-2.0

// #185-T02: no tracked source file uses a class name of the deleted legacy stylesheet. The scan
// reads the real files (the same list the SPDX check uses) and only looks in class contexts — a
// `className=`/`class=` attribute, the first string of a `cn`/`clsx`/`cva` call, or a CSS class
// selector — so an English word in a comment is never reported. The rule is in rules.ts.
//
// #185-T03: the deleted stylesheet and the `src/ui/*` wrappers are gone and nothing imports them.
// (The build and the existing tests staying green is the other half of that case; see the PR.)
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../spdx-headers/source-files.ts";
import {
  findRemovedClasses,
  findRemovedSelectors,
  REMOVED_CLASS_NAMES,
} from "./rules.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const files = listSourceFiles(repoRoot);

const CODE = /\.(tsx?|jsx?|mjs|cjs)$/;

function scan(path: string): { className: string; line: number }[] {
  const content = readFileSync(`${repoRoot}${path}`, "utf8");
  return path.endsWith(".css")
    ? findRemovedSelectors(content)
    : findRemovedClasses(content);
}

describe("no removed class name in the tree", () => {
  // #185-T02
  it("finds none across every tracked source file", () => {
    const offenders = files
      .filter((path) => path.endsWith(".css") || CODE.test(path))
      .flatMap((path) =>
        scan(path).map(
          (finding) => `${path}:${finding.line}: ${finding.className}`,
        ),
      );

    expect(offenders, "removed legacy class names").toEqual([]);
  });

  // #185-T02
  it("still finds a removed class in a component and in a stylesheet", () => {
    // The fixtures are built from parts so this file carries no removed class itself.
    const attribute = `class${'Name="'}b${"tn"} primary"`;
    expect(findRemovedClasses(attribute).map((f) => f.className)).toContain(
      "btn",
    );
    const helper = "c" + "n('mu" + "ted sm" + "all')";
    expect(findRemovedClasses(helper).map((f) => f.className)).toEqual([
      "muted",
      "small",
    ]);
    const selector = ".page" + "-header { margin: 0 }";
    expect(findRemovedSelectors(selector).map((f) => f.className)).toEqual([
      "page-header",
    ]);
  });

  // #185-T02
  it("does not report the words in a comment or an unrelated member access", () => {
    expect(
      findRemovedClasses("// a small card is drawn with the kit\nobj.field"),
    ).toEqual([]);
    expect(
      findRemovedSelectors("a.example { color: var(--x) }").map(
        (f) => f.className,
      ),
    ).toEqual([]);
  });

  // #185-T02
  it("covers the whole class set of the deleted stylesheet", () => {
    expect(REMOVED_CLASS_NAMES).toContain("run-row");
    expect(REMOVED_CLASS_NAMES).toContain("member-list");
    expect(REMOVED_CLASS_NAMES).toContain("checklist-item");
    expect(REMOVED_CLASS_NAMES).not.toContain("sr-only");
  });
});

describe("the deleted stylesheet and wrappers", () => {
  // #185-T03
  it("are gone from the tree", () => {
    for (const path of [
      "app/src/app/globals.css",
      "app/src/app/globals-layers.test.ts",
      "app/src/ui/button.tsx",
      "app/src/ui/page-header.tsx",
      "app/src/ui/empty-state.tsx",
    ]) {
      expect(existsSync(`${repoRoot}${path}`), path).toBe(false);
    }
  });

  // #185-T03
  it("leaves no source file importing one of the wrappers", () => {
    const legacyImport =
      /(?:@\/ui|(?:\.\.\/)+ui)\/(?:button|page-header|empty-state)\b/;
    const offenders = files
      .filter((path) => CODE.test(path))
      .filter((path) =>
        legacyImport.test(readFileSync(`${repoRoot}${path}`, "utf8")),
      );

    expect(offenders).toEqual([]);
  });
});
