// SPDX-License-Identifier: Apache-2.0

// The app draws its icons with Phosphor (`@phosphor-icons/react`), as the design board and the landing
// page do (#636). The scan reads the real source files, so an import of the former icon set added
// anywhere fails here and in `make verify`. The package name is built from parts so this file does
// not match itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../spdx-headers/source-files.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const FORMER = "lucide" + "-react";
const PHOSPHOR = "@phosphor-icons/react";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${repoRoot}${path}`, "utf8")) as Record<
    string,
    unknown
  >;
}

describe("the icon set of the app", () => {
  // #636-T01
  it("has no import of lucide left in any source file", () => {
    const importing = listSourceFiles(repoRoot).filter((path) =>
      readFileSync(`${repoRoot}${path}`, "utf8").includes(`"${FORMER}`),
    );

    expect(importing, "files importing lucide").toEqual([]);
  });

  // #636-T01
  it("depends on Phosphor and no longer on lucide", () => {
    const manifest = readJson("app/package.json");
    const dependencies = {
      ...(manifest.dependencies as Record<string, string>),
      ...(manifest.devDependencies as Record<string, string>),
    };

    expect(Object.keys(dependencies)).toContain(PHOSPHOR);
    expect(Object.keys(dependencies)).not.toContain(FORMER);
  });

  // #636-T01: components added with the shadcn CLI get Phosphor icons too.
  it("tells the shadcn CLI to use Phosphor", () => {
    expect(readJson("app/components.json").iconLibrary).toBe("phosphor");
  });
});
