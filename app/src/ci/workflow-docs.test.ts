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

/**
 * What the retired scheme left behind, as concrete patterns: Jira, epics, ticket keys such as `CR-14`
 * or `CR-<ticket>`, and the German heading of the Jira test case table. These are safe to ban in a
 * whole file.
 */
const oldScheme = /jira|\bepics?\b|\bCR-(\d+|<)|testf[aä]lle/i;

/**
 * Words of the retired scheme that are ordinary prose elsewhere ("user story" in a description of a
 * test, "ticket" in a quoted error). They are banned only where the text is about the workflow: the
 * whole of AGENTS.md, which holds nothing else, and the named sections of the other files.
 */
const oldWorkflowWords = /\btickets?\b|\bstor(y|ies)\b/i;

describe("AGENTS.md", () => {
  const text = read("AGENTS.md");

  it("mentions no part of the old Jira, epic and ticket scheme", () => {
    expect(text).not.toMatch(oldScheme);
    expect(text).not.toMatch(oldWorkflowWords);
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

  it("mentions no part of the old Jira and epic scheme", () => {
    expect(text).not.toMatch(oldScheme);
    expect(section(text, "Branching")).not.toMatch(oldWorkflowWords);
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

describe("TESTING.md", () => {
  const text = read("TESTING.md");

  it("mentions no part of the old Jira and epic scheme", () => {
    expect(text).not.toMatch(oldScheme);
    expect(section(text, "9. Test cases in GitHub issues")).not.toMatch(
      oldWorkflowWords,
    );
  });

  it("takes the test cases from the GitHub issue", () => {
    const cases = section(text, "9. Test cases in GitHub issues");
    expect(cases).toContain('"Test cases" section');
    expect(cases).toContain("(T01, T02, ...)");
  });

  it("links a test to its test case with the bare case id", () => {
    expect(text).toContain("(`// T03` or `# T03`)");
  });

  it("sends repair work for a flaky journey to an issue", () => {
    expect(text).toContain("opens a repair issue");
  });
});

describe("oldScheme and oldWorkflowWords", () => {
  it("catch the keys and words of the retired scheme and pass the new one", () => {
    for (const old of [
      "Jira story",
      "an epic branch",
      "CR-14: add runner",
      "CR-<ticket>-<slug>",
      "## 9. Test cases in Jira",
      "a Testfälle section",
    ]) {
      expect(old).toMatch(oldScheme);
    }
    expect(
      "branch `<n>-<slug>` from `development`, `#14: add runner`, Closes #14",
    ).not.toMatch(oldScheme);
  });

  it("flag the workflow words only where a file opts in, so prose such as a user story stays legal", () => {
    for (const old of [
      "one ticket per branch",
      "the story covers",
      "stories",
    ]) {
      expect(old).toMatch(oldWorkflowWords);
    }
    // Neither pattern touches a description that merely mentions a user story or a ticket.
    expect("a test for the user story 'sign in'").not.toMatch(oldScheme);
  });
});
