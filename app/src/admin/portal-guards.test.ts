// SPDX-License-Identifier: Apache-2.0

// Pins down that every part of the admin portal asks for the admin itself, not only the proxy in front of
// it: each page calls `requireAdmin()`, the layout does too, each data route hands `lookupAdmin` to the
// handlers that check it first, and no file of Server Functions lives in the portal's folders (a Server
// Function is a POST to the page it lives on, and would need the same check in every function). The
// behavior of the guards is in guard.integration.test.ts; this finds the file that forgot one.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_DIRECTORY,
  concretePath,
  discoverRoutes,
} from "../test-support/routes.ts";
import { isInternalPortalPath } from "./paths.ts";

const ADMIN_PAGE_FOLDER = join(APP_DIRECTORY, "(app)", "instance-portal");
const SRC = join(APP_DIRECTORY, "..");

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
}

const routes = discoverRoutes().filter(({ route }) =>
  isInternalPortalPath(concretePath(route)),
);

describe("the guards of the admin portal", () => {
  it("are asked for by every page", () => {
    const pages = routes.filter(({ file }) => /page\.tsx?$/.test(file));
    expect(pages.length).toBeGreaterThan(0);

    const unguarded = pages
      .filter(
        ({ file }) => !/\brequireAdmin\(\)/.test(readFileSync(file, "utf8")),
      )
      .map(({ route }) => route);

    expect(unguarded).toEqual([]);
  });

  it("are asked for by the layout of the portal, before it renders anything", () => {
    const layout = readFileSync(join(ADMIN_PAGE_FOLDER, "layout.tsx"), "utf8");

    expect(layout).toMatch(/await requireAdmin\(\)/);
  });

  // #182-T05
  it("guard the GitHub App page of the portal like every other page", () => {
    const page = discoverRoutes().find(
      ({ route }) =>
        concretePath(route) === "/instance-portal/integrations/github",
    );

    expect(page).toBeDefined();
    // The proxy recognizes the new sub-page as a portal path (src/admin/paths.ts) ...
    expect(isInternalPortalPath(concretePath(page!.route))).toBe(true);
    // ... and the page asks for the admin itself.
    expect(readFileSync(page!.file, "utf8")).toMatch(/\brequireAdmin\(\)/);
  });

  it("are handed to the handlers by every data route", () => {
    const handlers = routes.filter(({ file }) => /route\.tsx?$/.test(file));
    expect(handlers.length).toBeGreaterThan(0);

    const unguarded = handlers
      .filter(({ file }) => {
        const source = readFileSync(file, "utf8");
        return !(
          /\bcreate(Admin|Github|Approval)RouteHandlers\(/.test(source) &&
          /\baccess:\s*lookupAdmin\b/.test(source)
        );
      })
      .map(({ route }) => route);

    expect(unguarded).toEqual([]);
  });

  it("leave no Server Function in the portal's folders, which would need a guard of its own", () => {
    const files = [
      ...filesBelow(ADMIN_PAGE_FOLDER),
      ...filesBelow(join(SRC, "admin")),
      ...filesBelow(join(APP_DIRECTORY, "api", "instance-portal")),
    ];

    const withServerFunctions = files.filter((file) =>
      /^\s*(["'])use server\1/m.test(
        readFileSync(file, "utf8").split("\n").slice(0, 5).join("\n"),
      ),
    );

    expect(withServerFunctions).toEqual([]);
  });
});
