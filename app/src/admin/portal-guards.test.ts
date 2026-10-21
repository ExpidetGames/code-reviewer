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

  // #504-T11
  it("guard the billing page and its data routes like every other part of the portal", () => {
    const billing = discoverRoutes().filter(({ route }) =>
      /^\/(api\/)?instance-portal\/billing/.test(concretePath(route)),
    );

    expect(billing.map(({ route }) => route).sort()).toEqual([
      "/api/instance-portal/billing",
      "/api/instance-portal/billing/check",
      "/api/instance-portal/billing/reviews",
      "/api/instance-portal/billing/reviews/check",
      "/api/instance-portal/billing/reviews/resolve",
      "/api/instance-portal/billing/webhook-endpoint",
      "/api/instance-portal/billing/workspaces",
      "/api/instance-portal/billing/workspaces/[id]",
      "/api/instance-portal/billing/workspaces/[id]/credit",
      "/instance-portal/billing",
      "/instance-portal/billing/reviews",
    ]);
    for (const { route, file } of billing) {
      expect(isInternalPortalPath(concretePath(route))).toBe(true);
      const source = readFileSync(file, "utf8");
      if (/page\.tsx?$/.test(file))
        expect(source, route).toMatch(/\brequireAdmin\(\)/);
      else {
        expect(source, route).toMatch(/\bcreateBillingRouteHandlers\(/);
        expect(source, route).toMatch(/\baccess:\s*lookupAdmin\b/);
      }
    }
  });

  // #504-T01
  it("keeps the provider-facing webhook the only public billing route outside the portal", () => {
    const outside = discoverRoutes().filter(
      ({ route }) =>
        /billing/i.test(concretePath(route)) &&
        !isInternalPortalPath(concretePath(route)) &&
        // A route of a workspace is not public: it runs through `withWorkspace` (the membership and the role of the
        // person), which `src/workspaces/guard-rule.test.ts` pins for every route below `/api/w/`. #501 adds the top-up.
        !concretePath(route).startsWith("/api/w/"),
    );

    // The signature checked by the active adapter is its credential (src/auth/access.ts); every page and data route of the
    // billing admin is below the portal and guarded above.
    expect(outside.map(({ route }) => concretePath(route))).toEqual([
      "/api/billing/webhook",
    ]);
  });

  // #501-T04
  it("runs every billing route of a workspace through the access check of a workspace with the billing action", () => {
    const routes = discoverRoutes().filter(
      ({ route }) =>
        /billing/i.test(concretePath(route)) &&
        concretePath(route).startsWith("/api/w/"),
    );

    // Changed with #502: "Check payment" is the second billing route of a workspace, and it passes the same guard.
    expect(routes.map(({ route }) => concretePath(route)).sort()).toEqual([
      "/api/w/x/billing/top-ups",
      "/api/w/x/billing/top-ups/x/check",
    ]);
    for (const { route, file } of routes)
      expect(readFileSync(file, "utf8"), route).toMatch(
        /\bwithWorkspace\(\s*workspace,\s*"manage_billing"/,
      );
  });

  // #429-T08
  it("guard the model catalog routes and the page that shows it like every other part of the portal", () => {
    const catalog = discoverRoutes().filter(({ route }) =>
      concretePath(route).startsWith("/api/instance-portal/model-catalog"),
    );

    expect(catalog.map(({ route }) => route).sort()).toEqual([
      "/api/instance-portal/model-catalog",
      "/api/instance-portal/model-catalog/[id]",
      "/api/instance-portal/model-catalog/[id]/release",
      "/api/instance-portal/model-catalog/[id]/retire",
      "/api/instance-portal/model-catalog/check",
      "/api/instance-portal/model-catalog/defaults",
      "/api/instance-portal/model-catalog/order",
    ]);
    for (const { route, file } of catalog) {
      expect(isInternalPortalPath(concretePath(route))).toBe(true);
      const source = readFileSync(file, "utf8");
      expect(source, route).toMatch(/\bcreateCatalogRouteHandlers\(/);
      expect(source, route).toMatch(/\baccess:\s*lookupAdmin\b/);
    }
    // The catalog has no page of its own: it is a section of the LLM page, which asks for the admin itself.
    const page = discoverRoutes().find(
      ({ route }) => concretePath(route) === "/instance-portal/llm",
    );
    expect(page).toBeDefined();
    const source = readFileSync(page!.file, "utf8");
    expect(source).toMatch(/\brequireAdmin\(\)/);
    expect(source).toMatch(/<ModelCatalogSection\b/);
  });

  // #549-T08
  it("guard the catalog price routes like every other part of the portal, and keep them out of every other area", () => {
    const prices = discoverRoutes().filter(({ route }) =>
      concretePath(route).startsWith("/api/instance-portal/catalog-models"),
    );

    expect(prices.map(({ route }) => route).sort()).toEqual([
      "/api/instance-portal/catalog-models",
      "/api/instance-portal/catalog-models/enablement",
      "/api/instance-portal/catalog-models/enablement/reset",
      "/api/instance-portal/catalog-models/price/confirm",
      "/api/instance-portal/catalog-models/price/correct",
    ]);
    for (const { route, file } of prices) {
      expect(isInternalPortalPath(concretePath(route))).toBe(true);
      const source = readFileSync(file, "utf8");
      expect(source, route).toMatch(/\bcreateModelPriceRouteHandlers\(/);
      expect(source, route).toMatch(/\baccess:\s*lookupAdmin\b/);
    }
  });

  // #554-T09
  it("guard the models.dev catalog routes and its page like every other part of the portal, and keep them out of every other area", () => {
    const catalog = discoverRoutes().filter(({ route }) =>
      /^\/api\/instance-portal\/catalog-(providers|fetch)/.test(
        concretePath(route),
      ),
    );

    expect(catalog.map(({ route }) => route).sort()).toEqual([
      "/api/instance-portal/catalog-fetch",
      "/api/instance-portal/catalog-providers/url/confirm",
    ]);
    for (const { route, file } of catalog) {
      expect(isInternalPortalPath(concretePath(route))).toBe(true);
      const source = readFileSync(file, "utf8");
      expect(source, route).toMatch(/\bcreateModelsDevRouteHandlers\(/);
      expect(source, route).toMatch(/\baccess:\s*lookupAdmin\b/);
    }
    const page = discoverRoutes().find(
      ({ route }) => concretePath(route) === "/instance-portal/catalog",
    );
    expect(page).toBeDefined();
    expect(isInternalPortalPath(concretePath(page!.route))).toBe(true);
    const source = readFileSync(page!.file, "utf8");
    expect(source).toMatch(/\brequireAdmin\(\)/);
    expect(source).toMatch(/<AdminCatalogContent\b/);
  });

  it("are handed to the handlers by every data route", () => {
    const handlers = routes.filter(({ file }) => /route\.tsx?$/.test(file));
    expect(handlers.length).toBeGreaterThan(0);

    const unguarded = handlers
      .filter(({ file }) => {
        const source = readFileSync(file, "utf8");
        return !(
          /\bcreate(Admin|Github|Approval|Billing|Catalog|ModelPrice|ModelsDev)RouteHandlers\(/.test(
            source,
          ) && /\baccess:\s*lookupAdmin\b/.test(source)
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
