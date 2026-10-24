// SPDX-License-Identifier: LicenseRef-Proprietary

// The journeys of the normal Playwright lane share one fake GitHub, which keys its accounts, installations and
// repositories by id: a second writer of an id silently replaces the first (fakes/github/oauth.ts), so two journeys
// that pick the same number break each other only when they happen to run at the same time. The journeys of the
// operator limits (#285) have ranges of their own (771xxxx accounts, 781xxxx organizations, 981xxxx installations
// and repositories, 741xxxx / 951xxxx / 961xxxx for the plain instance). This test keeps the ids of those files out
// of every other file that uses the same fake. The lanes with a fake of their own (e2e/hosted, e2e/dynamic) may
// repeat an id.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const e2eRoot = fileURLToPath(new URL("../../e2e/", import.meta.url));
// Ids of the fake GitHub are seven digits starting with 7 or 9.
const ID = /\b[79]\d{6}\b/g;

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function idsOf(path: string): Set<string> {
  return new Set(readFileSync(path, "utf8").match(ID) ?? []);
}

describe("the ids of the fake GitHub in the e2e journeys", () => {
  // #285
  it("are not shared between the operator journeys and any other journey that uses the same fake GitHub", () => {
    const files = filesIn(e2eRoot).map((path) => relative(e2eRoot, path));
    const own = files.filter((file) => file.startsWith("operator/"));
    const others = files.filter(
      (file) =>
        !file.startsWith("operator/") &&
        !file.startsWith("hosted/") &&
        !file.startsWith("dynamic/"),
    );
    expect(own.length).toBeGreaterThan(0);
    const shared: string[] = [];
    for (const file of own)
      for (const id of idsOf(join(e2eRoot, file)))
        for (const other of others)
          if (idsOf(join(e2eRoot, other)).has(id))
            shared.push(`${id} is in ${file} and in ${other}`);
    expect(shared).toEqual([]);
  });
});
