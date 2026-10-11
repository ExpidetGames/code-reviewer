// Pins down the community files that GitHub looks for (CONTRIBUTING.md, CODE_OF_CONDUCT.md,
// SECURITY.md): that they exist, that the Code of Conduct has a real way to report, that the
// contribution guide names the commands and rules the project actually has, that their relative
// links resolve and that the public files mention nothing internal.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const files = ["CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md"] as const;

describe.each(files)("%s", (file) => {
  const text = read(file);

  it("exists and is not a stub", () => {
    expect(text.length).toBeGreaterThan(1000);
  });

  it("keeps internal systems and addresses out of a public repository", () => {
    expect(text).not.toMatch(
      /jira|atlassian|confluence|webspired\.de|localhost:3100/i,
    );
    expect(text).not.toContain("—");
  });

  it("links only to files that exist", () => {
    const links = [
      ...text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g),
    ].map((m) => m[1]);

    for (const link of links) {
      expect(
        existsSync(resolve(dirname(`${repoRoot}${file}`), link ?? "")),
        link,
      ).toBe(true);
    }
  });
});

describe("CODE_OF_CONDUCT.md", () => {
  const text = read("CODE_OF_CONDUCT.md");

  it("adopts the Contributor Covenant 2.1", () => {
    expect(text).toContain("Contributor Covenant Code of Conduct");
    expect(text).toContain("version 2.1");
  });

  it("names a working way to report instead of the template placeholder", () => {
    expect(text).not.toContain("[INSERT CONTACT METHOD]");
    expect(text).toContain(
      "https://github.com/ExpidetGames/code-reviewer/security/advisories/new",
    );
  });
});

describe("SECURITY.md", () => {
  const text = read("SECURITY.md");

  it("asks for private reports through GitHub security advisories", () => {
    expect(text).toContain(
      "https://github.com/ExpidetGames/code-reviewer/security/advisories/new",
    );
    expect(text).toMatch(/do not (open|report)[^.]*public issue/i);
  });

  it("states supported versions, response times and the disclosure policy", () => {
    expect(text).toMatch(/## Supported versions/);
    expect(text).toMatch(/## What to expect/);
    expect(text).toMatch(/## Disclosure/);
  });
});

describe("CONTRIBUTING.md", () => {
  const text = read("CONTRIBUTING.md");

  it("explains setup and the checks that must be green before a pull request", () => {
    expect(text).toContain("make install");
    expect(text).toContain("make verify");
    expect(text).toContain("make test-images");
    expect(text).toContain("make test-compose");
  });

  it("points to the test levels in TESTING.md", () => {
    expect(text).toContain("TESTING.md");
  });

  it("states the branch, commit and pull request conventions", () => {
    expect(text).toContain("Closes #");
    expect(text).toContain("<issue number>-<short-slug>");
    expect(text).toContain("`development`");
  });

  it("says contributions are under Apache-2.0 without a contributor license agreement", () => {
    expect(text).toContain("Apache License, Version 2.0");
    expect(text).toMatch(/no (CLA|contributor license agreement)/i);
  });

  it("points newcomers to the labels good first issue and help wanted", () => {
    expect(text).toContain("good first issue");
    expect(text).toContain("help wanted");
  });

  it("links the code of conduct and the security policy", () => {
    expect(text).toContain("CODE_OF_CONDUCT.md");
    expect(text).toContain("SECURITY.md");
  });
});
