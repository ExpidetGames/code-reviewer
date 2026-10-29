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
  findText,
  type OldNameException,
  withoutExceptions,
} from "./old-name-scan.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { DEFAULT_REVIEW_SKILL } from "../review-settings/default-skill.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// Built from parts, so this file does not say the old name itself.
const OLD = ["Code", "Reviewer"].join(" ");

const EXCEPTIONS: readonly OldNameException[] = [
  {
    path: "app/src/product-identity/code-review-com.ts",
    text: OLD,
    reason:
      "the name of the check run and the base of the suggested name of the GitHub App of code-review.com (#740: they are fields of its identity): identifiers on GitHub, and branch protection rules match the check name",
  },
  {
    path: "app/src/review-settings/default-skill.ts",
    text: DEFAULT_REVIEW_SKILL.text.trim(),
    reason:
      "the license notice of the shipped skill; its text is a versioned, hashed contract asset",
  },
];

// The modules that took the name from the identity first (#715, cut 7); since #740 no text of the app writes it (the next
// test), so this list is the minimum that can never get an exception.
const WITHOUT_LITERAL_NAME: readonly string[] = [
  "app/src/components/brand.tsx",
  "app/src/copy/model-choice.ts",
  "app/src/mail/balance-message.ts",
  "app/src/mail/invitation-message.ts",
  "app/src/mail/password-reset-message.ts",
  "app/src/mail/test-mail.ts",
  "app/src/mail/verification-message.ts",
];

// The one place that writes the name of code-review.com: its identity (#740). Everything else gets it from there.
const NAME_EXCEPTIONS: readonly OldNameException[] = [
  {
    path: "app/src/product-identity/code-review-com.ts",
    text: "code-review.com",
    reason: "the identity of code-review.com",
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

  // #715-T07
  it("is not a literal in the modules that take it from the identity", () => {
    const findings = WITHOUT_LITERAL_NAME.flatMap((path) =>
      findText(
        path,
        readFileSync(`${repoRoot}${path}`, "utf8"),
        /code-review\.com/i,
      ),
    );

    expect(findings).toEqual([]);
  });

  // #740-T06
  it("is not a literal in any text of the app: every word of the product comes from its identity", () => {
    const findings = listSourceFiles(repoRoot)
      .filter(isScanned)
      .flatMap((path) =>
        findText(
          path,
          readFileSync(`${repoRoot}${path}`, "utf8"),
          /code-review\.com/i,
        ),
      );

    expect(withoutExceptions(findings, NAME_EXCEPTIONS)).toEqual([]);
  });

  // #740-T06
  it("is not a literal in a file that takes a ProductIdentity, and no exception covers one", () => {
    const takers = listSourceFiles(repoRoot)
      .filter(isScanned)
      .filter((path) =>
        /product-identity\/identity(\.ts)?"/.test(
          readFileSync(`${repoRoot}${path}`, "utf8"),
        ),
      );

    // A file that takes the identity is found by its import of the type: the scan would pass vacuously on none.
    expect(takers.length).toBeGreaterThan(20);
    const findings = takers.flatMap((path) =>
      [/code-review\.com/i, /code\s+reviewer/i].flatMap((pattern) =>
        findText(path, readFileSync(`${repoRoot}${path}`, "utf8"), pattern),
      ),
    );
    expect(findings).toEqual([]);
  });

  // #715-T07
  it("finds the literal name in a string, a template and a JSX text, but not in a comment", () => {
    const content = [
      "// Welcome to code-review.com.",
      'export const a = "Join code-review.com";',
      "export const b = `Hello ${name}, welcome to code-review.com`;",
      "export const C = () => <p>Set up code-review.com</p>;",
    ].join("\n");

    expect(
      findText("app/src/x.tsx", content, /code-review\.com/i).map(
        (f) => f.line,
      ),
    ).toEqual([2, 3, 4]);
  });

  // #635-T01
  it("is written in lowercase as code-review.com", () => {
    expect(getProductIdentity().name).toBe("code-review.com");
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
