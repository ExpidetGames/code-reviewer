// Keeps docs/github-app.md (the guide for creating the team's GitHub App) in step with the code: the
// permissions and webhook events the guide tells people to set are exactly the ones the code works
// with, the webhook path is the route that exists, and every environment variable the loader reads
// is explained. A change to the code that is not mirrored in the guide fails here.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOB_TOKEN_PERMISSIONS } from "./job-access.ts";
import { WEBHOOK_READ_FIELDS } from "./webhook-fields.ts";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const guide = readFileSync(`${repoRoot}docs/github-app.md`, "utf8");

/** The text of the section that starts with the given heading, up to the next heading of that level. */
function section(heading: string): string {
  const start = guide.indexOf(`\n## ${heading}\n`);
  if (start === -1)
    throw new Error(`docs/github-app.md has no "${heading}" section`);
  const rest = guide.slice(start + 1);
  const next = rest.indexOf("\n## ", 3);
  return next === -1 ? rest : rest.slice(0, next);
}

const ACCESS_TEXT = { read: "Read-only", write: "Read and write" } as const;

describe("the GitHub App setup guide", () => {
  // CR-38-T01
  it("lists exactly the repository permissions the code works with, at the same access level", () => {
    const listed: Record<string, string> = {};
    for (const row of section("Permissions").matchAll(
      /^\|[^|]*\(`(\w+)`\)[^|]*\|\s*(Read-only|Read and write)\s*\|/gm,
    ))
      listed[row[1] as string] = row[2] as string;

    const expected = Object.fromEntries(
      Object.entries(JOB_TOKEN_PERMISSIONS).map(([name, level]) => [
        name,
        ACCESS_TEXT[level],
      ]),
    );
    expect(listed).toEqual(expected);
  });

  // CR-38-T01
  it("lists exactly the webhook events the code reads", () => {
    const listed = [...section("Events").matchAll(/^\|\s*`(\w+)`\s*\|/gm)].map(
      (row) => row[1],
    );

    expect(listed.sort()).toEqual(Object.keys(WEBHOOK_READ_FIELDS).sort());
  });

  // CR-38-T01
  it("says which of the events are ticked by hand and which GitHub always sends", () => {
    const events = section("Events");

    expect(events).toMatch(/`pull_request`[^\n]*tick/i);
    expect(events).toMatch(/`issue_comment`[^\n]*tick/i);
    expect(events).toMatch(/`installation`[^\n]*always/i);
    expect(events).toMatch(/`installation_repositories`[^\n]*always/i);
  });

  it("gives the webhook path of a route that exists", () => {
    const route = "app/src/app/api/webhooks/github-app/route.ts";

    expect(existsSync(`${repoRoot}${route}`)).toBe(true);
    expect(guide).toContain("/api/webhooks/github-app");
  });

  it("names every environment variable the loader reads, and no write permission beyond the list", () => {
    for (const name of [
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_PRIVATE_KEY_PATH",
    ])
      expect(guide, name).toContain(name);
    // The MVP asks for no Checks permission (decision of the project lead).
    expect(section("Permissions")).not.toMatch(/\(`checks`\)/);
  });
});
