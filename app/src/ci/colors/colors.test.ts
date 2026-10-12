// SPDX-License-Identifier: Apache-2.0

// #166-T01: every color of the app lives in `app/src/app/theme.css` (the UI redesign decision D2).
// The scan reads the real source files, so a color literal added anywhere else fails here and in
// `make verify`. `app/src/app/globals.css` is the one documented exception of the incremental
// migration; the cleanup issue (#185) removes it. The rule itself is in rules.ts.
//
// The fixtures below build every sample from parts, so this file carries no color itself (the guard
// scans it too).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../spdx-headers/source-files.ts";
import {
  COLOR_FILE,
  COLOR_FILE_EXCEPTION,
  findColorLiterals,
  isColorException,
  scanColors,
} from "./rules.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const HEX = `#${"ff"}0000`;
const SHORT_HEX = `#${"f0"}f`;
const RGB = "rgb" + "(";
const HSL = "hsl" + "(";
const OKLCH = "oklch" + "(";
const NAMED = "red";
const REBECCA = "rebeccapurple";
const QUOTED_STYLE = `style={{ color: ${JSON.stringify(NAMED)} }}`;
const PALETTE_CLASS = "bg-" + "red-" + "500";
const PALETTE_BLACK = "text-" + "black";

describe("no color literal outside theme.css", () => {
  // #166-T01
  it("passes on the tree, with only theme.css and the legacy globals.css exempt", () => {
    const files = listSourceFiles(repoRoot).map((path) => ({
      path,
      content: readFileSync(`${repoRoot}${path}`, "utf8"),
    }));

    expect(scanColors(files), "color literals outside theme.css").toEqual([]);
    expect(isColorException(COLOR_FILE)).toBe(true);
    expect(isColorException(COLOR_FILE_EXCEPTION)).toBe(true);
  });

  // #166-T01
  it("fails on a hex color added to a component and names its path", () => {
    const found = scanColors([
      {
        path: "app/src/components/ui/button.tsx",
        content: `export const B = () => <span className="text-[${HEX}]">x</span>;\n`,
      },
    ]);

    expect(found).toEqual([
      { path: "app/src/components/ui/button.tsx", literal: HEX, line: 1 },
    ]);
  });
});

describe("findColorLiterals", () => {
  // #166-T01
  it.each([
    ["a hex color", `color: ${HEX};`, HEX],
    ["a short hex color", `border-color: ${SHORT_HEX};`, SHORT_HEX],
    ["an rgb function", `background: ${RGB}1 2 3);`, RGB],
    ["an hsl function", `color: ${HSL}210 78% 40%);`, HSL],
    ["an oklch function", `color: ${OKLCH}0.7 0.1 250);`, OKLCH],
    ["a named color in a declaration", `color: ${NAMED};`, NAMED],
    [
      "a named color in an arbitrary value",
      `className="bg-[${REBECCA}]"`,
      REBECCA,
    ],
    ["a named color in a quoted style value", QUOTED_STYLE, NAMED],
    ["a Tailwind palette background utility", PALETTE_CLASS, PALETTE_CLASS],
    ["a Tailwind palette text utility", PALETTE_BLACK, PALETTE_BLACK],
  ])("finds %s", (_name, content, literal) => {
    expect(
      findColorLiterals(content).map((finding) => finding.literal),
    ).toContain(literal);
  });

  // #166-T01
  it.each([
    ["an issue reference in a comment", "// #166-T01, #138, #102-GH-19"],
    ["the words of prose", "reject a token with white space around it"],
    ["a variable reference", "background: var(--primary);"],
    ["a Tailwind utility by name", "className='text-muted-foreground'"],
    [
      "a token utility that only looks like a palette name",
      "className='bg-background text-foreground'",
    ],
  ])("does not treat %s as a color", (_name, content) => {
    expect(findColorLiterals(content)).toEqual([]);
  });
});
