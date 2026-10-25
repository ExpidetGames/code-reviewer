// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the community files that GitHub looks for (CONTRIBUTING.md, SECURITY.md): that they
// exist, that the contribution guide says that external contributions are not accepted and still
// names the commands and rules the team actually has, that the security policy has a real way to
// report, that their relative links resolve and that the public files mention nothing internal.
// The project is proprietary (#677): there is no code of conduct for a community that does not exist.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPOSITORY } from "./workflow-support.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

/** Relative link targets of a Markdown text: inline links and reference definitions, anchors cut off. */
function relativeLinks(text: string): string[] {
  const inline = [...text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g)];
  const definitions = [
    ...text.matchAll(/^\[[^\]]+\]:\s*(?!https?:|#|mailto:)([^#\s]+)/gm),
  ];
  return [...inline, ...definitions].map((match) => match[1] ?? "");
}

const files = ["CONTRIBUTING.md", "SECURITY.md"] as const;

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
    for (const link of relativeLinks(text)) {
      expect(
        existsSync(resolve(dirname(`${repoRoot}${file}`), link)),
        link,
      ).toBe(true);
    }
  });
});

describe("relativeLinks", () => {
  it("finds inline links and reference-style definitions, and skips web, anchor and mail links", () => {
    const sample = [
      "See [a](docs/a.md#part), [b][ref], [web](https://example.com), [top](#top).",
      "",
      "[ref]: ./b.md",
      "[site]: https://example.com/x",
      "[mail]: mailto:someone@example.com",
    ].join("\n");

    expect(relativeLinks(sample)).toEqual(["docs/a.md", "./b.md"]);
  });
});

describe("CODE_OF_CONDUCT.md", () => {
  it("does not exist, because the project has no community to set rules for", () => {
    expect(existsSync(`${repoRoot}CODE_OF_CONDUCT.md`)).toBe(false);
  });
});

describe("SECURITY.md", () => {
  const text = read("SECURITY.md");

  it("asks for private reports through GitHub security advisories", () => {
    expect(text).toContain(
      `https://github.com/${REPOSITORY}/security/advisories/new`,
    );
    expect(text).toMatch(/do not (open|report)[^.]*public issue/i);
  });

  it("is about the hosted service and not about versions or images that somebody runs", () => {
    expect(text).toContain("hosted service");
    expect(text).not.toMatch(/published container images|compose\.yml/);
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

  it("says up front that external contributions are not accepted", () => {
    const start = text.slice(0, 800);

    expect(start).toContain("External contributions are not accepted");
    expect(start).toContain("proprietary");
    expect(start).toContain("LICENSE");
    expect(start).toMatch(/in writing/i);
  });

  it("states the proprietary header and no longer an open source license or a contributor agreement", () => {
    expect(text).toContain("SPDX-License-Identifier: LicenseRef-Proprietary");
    expect(text).not.toMatch(/Apache License, Version 2\.0/);
    expect(text).not.toMatch(/licensed under the same terms/i);
  });

  it("no longer invites anybody to pick up an issue or to fork", () => {
    expect(text).not.toContain("good first issue");
    expect(text).not.toContain("help wanted");
    expect(text).not.toMatch(/Fork the repository|your fork/i);
    expect(text).not.toContain("CODE_OF_CONDUCT.md");
  });

  it("links the security policy", () => {
    expect(text).toContain("SECURITY.md");
  });
});
