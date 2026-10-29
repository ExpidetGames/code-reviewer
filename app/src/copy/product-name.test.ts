// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the product name (#635): no page, text or mail of the app says the old name "Code Reviewer"
// any more, it says "code-review.com". The scan reads the real source files of the app (every string,
// template and JSX text outside the tests), so a new sentence with the old name fails here. The few
// texts that keep it are external identifiers, each listed with its reason.
//
// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../ci/spdx-headers/source-files.ts";
import {
  findOldName,
  type OldNameException,
  withoutExceptions,
} from "./old-name-scan.ts";
import { CODE_REVIEW_COM } from "../product-identity/code-review-com.ts";
import { DEFAULT_REVIEW_SKILL } from "../review-settings/default-skill.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// Built from parts, so this file does not say the old name itself.
const OLD = ["Code", "Reviewer"].join(" ");

const EXCEPTIONS: readonly OldNameException[] = [
  {
    path: "app/src/check-runs/service.ts",
    text: OLD,
    reason:
      "the name of the check run on GitHub; branch protection rules match it",
  },
  {
    path: "app/src/integrations/providers/github-app/manifest.ts",
    text: OLD,
    reason:
      "the suggested name of the GitHub App (alone and before the host), an identifier on GitHub",
  },
  {
    path: "app/src/review-settings/default-skill.ts",
    text: DEFAULT_REVIEW_SKILL.text.trim(),
    reason:
      "the license notice of the shipped skill; its text is a versioned, hashed contract asset",
  },
];

function isScanned(path: string): boolean {
  return (
    path.startsWith("app/src/") &&
    /\.tsx?$/.test(path) &&
    !/\.test\.tsx?$/.test(path) &&
    !path.startsWith("app/src/test-support/")
  );
}

describe("the product name", () => {
  // #635-T01
  it("is never the old name in a text of the app outside the listed identifiers", () => {
    const findings = listSourceFiles(repoRoot)
      .filter(isScanned)
      .flatMap((path) =>
        findOldName(path, readFileSync(`${repoRoot}${path}`, "utf8")),
      );

    expect(withoutExceptions(findings, EXCEPTIONS)).toEqual([]);
  });

  // #635-T01
  it("is written in lowercase as code-review.com", () => {
    expect(CODE_REVIEW_COM.name).toBe("code-review.com");
  });

  // #635-T01
  it("finds the old name in a string, a template and a JSX text, but not in a comment", () => {
    const content = [
      `// About ${OLD}.`,
      `export const a = "Join ${OLD}";`,
      "export const b = `Hello ${name}, welcome to " + OLD + "`;",
      `export const C = () => <p>Set up ${OLD}</p>;`,
    ].join("\n");

    const found = findOldName("app/src/x.tsx", content);

    expect(found).toEqual([
      { path: "app/src/x.tsx", line: 2, text: `Join ${OLD}` },
      { path: "app/src/x.tsx", line: 3, text: `, welcome to ${OLD}` },
      { path: "app/src/x.tsx", line: 4, text: `Set up ${OLD}` },
    ]);
  });
});
