// Pins down that AGENTS.md and the README describe the same GitHub issue workflow as
// CONTRIBUTING.md (issue `#n`, branch `<n>-<slug>` from `development`, pull request into
// `development` with `Closes #n`, squash merge) and no longer the retired epic/ticket scheme with
// Jira keys.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

/** The text of one `## ` section, from its heading up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  expect(start, `section "${heading}"`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

/** What the retired scheme left behind: Jira, epics, ticket keys such as CR-14, "ticket" and "story". */
const oldScheme = /jira|\bepics?\b|\bCR-(\d+|<)|\btickets?\b|\bstor(y|ies)\b/i;

describe("AGENTS.md", () => {
  const text = read("AGENTS.md");

  it("mentions no part of the old Jira, epic and ticket scheme", () => {
    expect(text).not.toMatch(oldScheme);
  });

  it("describes the issue workflow of CONTRIBUTING.md", () => {
    const branches = section(text, "Branches and pull requests");
    expect(branches).toContain("<n>-<slug>");
    expect(branches).toContain("`development`");
    expect(branches).toContain("Closes #<n>");
    expect(branches).toMatch(/squash/i);
    expect(branches).toMatch(/`#\d+: /);
  });

  it("sends agents to the GitHub issue instead of a story", () => {
    expect(text).toMatch(/then the (GitHub )?issue/);
  });
});

describe("README.md", () => {
  const text = read("README.md");

  it("mentions no part of the old Jira, epic and ticket scheme", () => {
    expect(text).not.toMatch(oldScheme);
  });

  it("describes the branching of CONTRIBUTING.md", () => {
    const branching = section(text, "Branching");
    expect(branching).toContain("<n>-<slug>");
    expect(branching).toContain("`development`");
    expect(branching).toContain("Closes #<n>");
    expect(branching).toMatch(/squash/i);
    expect(branching).toContain("`main`");
  });

  it("points to CONTRIBUTING.md for the full workflow", () => {
    expect(section(text, "Branching")).toContain("CONTRIBUTING.md");
  });
});

describe("oldScheme", () => {
  it("catches the words and keys of the retired scheme and passes the new one", () => {
    for (const old of [
      "Jira story",
      "an epic branch",
      "CR-14: add runner",
      "CR-<ticket>-<slug>",
      "one ticket per branch",
      "Jira stories may be German",
    ]) {
      expect(old).toMatch(oldScheme);
    }
    expect(
      "branch `<n>-<slug>` from `development`, `#14: add runner`, Closes #14",
    ).not.toMatch(oldScheme);
  });
});
