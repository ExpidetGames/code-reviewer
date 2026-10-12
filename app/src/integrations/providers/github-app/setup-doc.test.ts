// SPDX-License-Identifier: Apache-2.0

// Keeps docs/github-app.md (the guide for creating the team's GitHub App) in step with the code: the
// permissions and webhook events the guide tells people to set are exactly the ones the code works
// with, the webhook path is the route that exists, and every environment variable the loader reads
// is explained. A change to the code that is not mirrored in the guide fails here.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOB_TOKEN_PERMISSIONS } from "./job-access.ts";
import {
  ACCOUNT_PERMISSIONS,
  buildAppManifest,
  GITHUB_APP_PATHS,
  ORGANIZATION_PERMISSIONS,
  REPOSITORY_PERMISSIONS,
  SUBSCRIBED_EVENTS,
} from "./manifest.ts";
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

/** The text below the heading `### <heading>` up to the next heading, within a section. */
function subsection(text: string, heading: string): string {
  const start = text.indexOf(`\n### ${heading}\n`);
  if (start === -1) throw new Error(`no "${heading}" subsection`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n### ", 3);
  return next === -1 ? rest : rest.slice(0, next);
}

/** `| Name (`api_name`) | Read-only |` rows of a table, by API name. */
function permissionRows(text: string): Record<string, string> {
  const listed: Record<string, string> = {};
  for (const row of text.matchAll(
    /^\|[^|]*\(`(\w+)`\)[^|]*\|\s*(Read-only|Read and write)\s*\|/gm,
  ))
    listed[row[1] as string] = row[2] as string;
  return listed;
}

const expectedRows = (
  permissions: Readonly<Record<string, "read" | "write">>,
) =>
  Object.fromEntries(
    Object.entries(permissions).map(([name, level]) => [
      name,
      ACCESS_TEXT[level],
    ]),
  );

describe("the GitHub App setup guide", () => {
  // #102-GH-18
  it("lists exactly the repository permissions the code works with, at the same access level", () => {
    const listed = permissionRows(
      subsection(section("Permissions"), "Repository permissions"),
    );

    expect(listed).toEqual(expectedRows(JOB_TOKEN_PERMISSIONS));
    expect(REPOSITORY_PERMISSIONS).toEqual(JOB_TOKEN_PERMISSIONS);
  });

  // #102-GH-18
  it("lists the account permission and the organization permission the manifest asks for, read-only", () => {
    const permissions = section("Permissions");

    expect(
      permissionRows(subsection(permissions, "Account permissions")),
    ).toEqual(expectedRows(ACCOUNT_PERMISSIONS));
    expect(
      permissionRows(subsection(permissions, "Organization permissions")),
    ).toEqual(expectedRows(ORGANIZATION_PERMISSIONS));
  });

  // #102-GH-18
  it("is what the manifest asks for, permission by permission and event by event", () => {
    const permissions = section("Permissions");
    const documented = {
      ...permissionRows(subsection(permissions, "Repository permissions")),
      ...permissionRows(subsection(permissions, "Account permissions")),
      ...permissionRows(subsection(permissions, "Organization permissions")),
    };
    const manifest = buildAppManifest({
      publicUrl: "https://reviews.example.test",
      tenancy: "single",
      name: "Code Reviewer",
    });

    expect(documented).toEqual(
      expectedRows(
        manifest.default_permissions as Record<string, "read" | "write">,
      ),
    );
    expect(manifest.default_events).toEqual([...SUBSCRIBED_EVENTS]);
    // The events a person ticks are documented as ticked.
    for (const event of SUBSCRIBED_EVENTS)
      expect(section("Events")).toMatch(
        new RegExp(`\`${event}\`[^\\n]*tick`, "i"),
      );
  });

  // #102-GH-18
  it("gives the addresses of the manifest: the webhook, the callback of the sign in and the setup address", () => {
    expect(guide).toContain(GITHUB_APP_PATHS.webhook);
    expect(guide).toContain(GITHUB_APP_PATHS.signInCallback);
    expect(guide).toContain(GITHUB_APP_PATHS.installationSetup);
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

  // CR-38-T01
  it("gives the webhook path of a route that exists", () => {
    const route = "app/src/app/api/webhooks/github-app/route.ts";

    expect(existsSync(`${repoRoot}${route}`)).toBe(true);
    expect(guide).toContain("/api/webhooks/github-app");
  });

  // CR-38-T01
  it("names every environment variable the loader still reads for an installation that was not imported, and no write permission beyond the list", () => {
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
    // The variables of the separate OAuth app are documented as no longer used.
    expect(guide).toMatch(/GITHUB_OAUTH_CLIENT_ID[\s\S]*?not used any more/);
  });
});
