// SPDX-License-Identifier: LicenseRef-Proprietary

// #690-T05: the app answers an error with a body the page reads (`{ "error": <code> }`), and a proxy in front of it
// (Cloudflare) replaces the body of a 502 and a 504 with its own HTML page, so the page shows a generic text and the reason
// is lost. No route of the app answers with either status: a failure of a service behind the app (Stripe, GitHub, models.dev)
// is a 503. The scan reads the real source files, so a status map added later with a 502 or a 504 fails here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "./spdx-headers/source-files.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** A status written as a value or a type: `code: 502,`, `status: 504`, `| 502`. */
const GATEWAY_STATUS = /(?::|\|)\s*50[24]\b/;

export function findGatewayStatuses(
  files: { path: string; content: string }[],
): { path: string; line: number }[] {
  const found: { path: string; line: number }[] = [];
  for (const { path, content } of files)
    content.split("\n").forEach((text, index) => {
      const code = text.trimStart();
      if (code.startsWith("//") || code.startsWith("*")) return;
      if (GATEWAY_STATUS.test(text)) found.push({ path, line: index + 1 });
    });
  return found;
}

describe("no route answers 502 or 504", () => {
  // #690-T05
  it("passes on the source of the app", () => {
    const files = listSourceFiles(repoRoot)
      .filter(
        (path) =>
          path.startsWith("app/src/") &&
          /\.tsx?$/.test(path) &&
          !/\.test\.tsx?$/.test(path) &&
          !path.startsWith("app/src/ci/") &&
          !path.startsWith("app/src/test-support/"),
      )
      .map((path) => ({
        path,
        content: readFileSync(`${repoRoot}${path}`, "utf8"),
      }));

    expect(findGatewayStatuses(files), "502 or 504 in a status map").toEqual(
      [],
    );
  });

  // #690-T05
  it("names the file and the line of a status map with a 502", () => {
    const found = findGatewayStatuses([
      {
        path: "app/src/x/errors.ts",
        content: "const a = 1;\nexport const STATUS = { x_down: 502 };\n",
      },
      {
        path: "app/src/y/errors.ts",
        content: "// answered 502 before\nexport const T = 400 | 504;\n",
      },
    ]);

    expect(found).toEqual([
      { path: "app/src/x/errors.ts", line: 2 },
      { path: "app/src/y/errors.ts", line: 2 },
    ]);
  });
});
