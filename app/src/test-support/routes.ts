// Finds the routes of the app from the file system, for tests that must notice a route nobody
// decided about. The files below src/app that Next.js turns into a route: pages and route handlers
// (named by their folder) and metadata files such as robots, sitemap, manifest and icons (named by
// their own file name), as code or as static files.
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const APP_DIRECTORY = join(import.meta.dirname, "..", "app");

// File names Next.js turns into a route: pages and route handlers, and the metadata files
// (robots, sitemap, manifest, icons), as code or as static files.
const SCRIPT = "(ts|tsx|js|jsx|mjs)";
const ROUTE_FILE = new RegExp(`^(page|route)\\.${SCRIPT}$`);
const METADATA_FILE = new RegExp(
  `^(((robots|sitemap|manifest|(apple-)?icon\\d*|opengraph-image|twitter-image)\\.${SCRIPT})|` +
    `favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest\\.(json|webmanifest)|` +
    `((apple-)?icon|opengraph-image|twitter-image)\\d*\\.(ico|jpg|jpeg|png|svg|gif|webp|alt\\.txt))$`,
);

export type DiscoveredRoute = { route: string; file: string };

// Routes as the file system defines them: every page, route handler and metadata file below
// src/app. A page or handler is named by its folder, a metadata file by its own name.
export function discoverRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const isRoute = ROUTE_FILE.test(entry.name);
      if (!isRoute && !METADATA_FILE.test(entry.name)) continue;
      const segments = relative(APP_DIRECTORY, directory)
        .split(sep)
        .filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment));
      if (!isRoute) segments.push(entry.name);
      routes.push({ route: `/${segments.join("/")}`, file: path });
    }
  };
  walk(APP_DIRECTORY);
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

/** A concrete URL path for a route pattern such as `/api/auth/[...all]` or `/p/[id]`. */
export function concretePath(route: string): string {
  return route.replace(/\[\.\.\.[^\]]+\]/g, "x/y").replace(/\[[^\]]+\]/g, "x");
}
