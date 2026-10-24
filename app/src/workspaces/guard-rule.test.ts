// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the rule that a workspace address is only ever served for a member of that workspace, by the
// code that serves it and not only by the proxy: every page below `/w/<slug>` asks `requireWorkspace(...)`
// and every data route below `/api/w/<slug>` runs its handler through `withWorkspace(...)` (the membership
// and the role of the person, src/workspaces/access-runtime.ts), and nothing outside those addresses
// builds a service for a workspace from an id that came with the request. The routes are read from the file
// system, so a page or route added later without the guard makes this test fail. A route that names an
// action must name one that exists.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIRECTORY, discoverRoutes } from "../test-support/routes.ts";
import { WORKSPACE_ACTIONS } from "./permissions.ts";

const SRC = join(APP_DIRECTORY, "..");

const routes = discoverRoutes();
const isFile = (suffix: RegExp) => (entry: { file: string }) =>
  suffix.test(entry.file);
const pages = routes.filter(isFile(/[\\/]page\.[a-z]+$/));
const handlers = routes.filter(isFile(/[\\/]route\.[a-z]+$/));

const WORKSPACE_PAGES = pages.filter(({ route }) => route.startsWith("/w/"));
const WORKSPACE_HANDLERS = handlers.filter(({ route }) =>
  route.startsWith("/api/w/"),
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
}

describe("the pages and routes of a workspace", () => {
  it("find them all: the rule below is not about nothing", () => {
    expect(WORKSPACE_PAGES.length).toBeGreaterThanOrEqual(6);
    expect(WORKSPACE_HANDLERS.length).toBeGreaterThanOrEqual(10);
  });

  // #101-WM-07
  it("ask requireWorkspace on every page", () => {
    const unguarded = WORKSPACE_PAGES.filter(
      ({ file }) => !/\brequireWorkspace\(/.test(readFileSync(file, "utf8")),
    ).map(({ route }) => route);

    expect(unguarded).toEqual([]);
  });

  // #101-WM-07
  it("run every data route through withWorkspace, with an action that exists", () => {
    const unguarded: string[] = [];
    const unknownActions: string[] = [];
    for (const { route, file } of WORKSPACE_HANDLERS) {
      const source = readFileSync(file, "utf8");
      if (!/\bwithWorkspace\(/.test(source)) unguarded.push(route);
      for (const match of source.matchAll(
        /\bwithWorkspace\(\s*workspace,\s*"([a-z_]+)"/g,
      ))
        if (!(WORKSPACE_ACTIONS as readonly string[]).includes(match[1] ?? ""))
          unknownActions.push(`${route}: ${match[1] ?? ""}`);
      for (const match of source.matchAll(/\brun\(\s*context,\s*"([a-z_]+)"/g))
        if (!(WORKSPACE_ACTIONS as readonly string[]).includes(match[1] ?? ""))
          unknownActions.push(`${route}: ${match[1] ?? ""}`);
    }

    expect(unguarded).toEqual([]);
    expect(unknownActions).toEqual([]);
  });

  // #101-WM-07
  it("are the only places that make the service of a workspace from a workspace id taken from the address", () => {
    // `xxxServiceFor(...)` takes a workspace id. Pages and routes get that id from `access.workspace.id`
    // (the answer of the membership check), never from `params`: no file below `app/` passes a value taken
    // from the address to one of them.
    const offenders: string[] = [];
    for (const file of sourceFiles(APP_DIRECTORY)) {
      const source = readFileSync(file, "utf8");
      if (/ServiceFor\(\s*(params|workspace|slug)\b/.test(source))
        offenders.push(relative(SRC, file));
    }

    expect(offenders).toEqual([]);
  });

  it("recognizes a guard and the lack of one", () => {
    expect(/\bwithWorkspace\(/.test("return withWorkspace(w, 'view', f)")).toBe(
      true,
    );
    expect(/\bwithWorkspace\(/.test("// withWorkspace is mentioned only")).toBe(
      false,
    );
  });
});
