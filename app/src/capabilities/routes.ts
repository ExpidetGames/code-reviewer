// SPDX-License-Identifier: LicenseRef-Proprietary

// Which capability each route of the app belongs to (#731): the one table the proxy gate (gate.ts), the tests and
// the navigation read. A route is `core` (every deployment has it: sign-in, accounts, workspaces, members, the
// general admin portal, the health check) or belongs to one capability, and then it does not exist in a deployment
// without that capability. The patterns are the routes of `src/app` (`[workspace]` stands for one segment); a
// pattern matches the path and everything below it, `exact` only the path itself, and the longest pattern wins, so
// `/w/[workspace]/settings/billing` can belong to billing inside the core `/w/[workspace]/settings`.
// `capabilities/routes.test.ts` fails for a page or route file that no pattern covers, so a route added later
// has to be classified before it can be merged.
import { normalizePath } from "./path.ts";
import type { Capability, CapabilitySet } from "./capability.ts";

export type RouteClass = "core" | Capability;

type RouteEntry = {
  route: string;
  class: RouteClass;
  /** Only this path, not what is below it. */
  exact?: true;
};

export const ROUTE_CLASSES: readonly RouteEntry[] = [
  // Core: the way in, accounts, workspaces and the general admin portal.
  { route: "/", class: "core", exact: true },
  { route: "/login", class: "core" },
  { route: "/sign-up", class: "core" },
  { route: "/forgot-password", class: "core" },
  { route: "/reset-password", class: "core" },
  { route: "/verify-email", class: "core" },
  { route: "/invitation", class: "core" },
  { route: "/invitations", class: "core" },
  { route: "/no-access", class: "core" },
  { route: "/setup", class: "core" },
  { route: "/account", class: "core" },
  { route: "/settings", class: "core" },
  { route: "/workspaces", class: "core" },
  { route: "/github", class: "core" },
  { route: "/api/health", class: "core" },
  { route: "/api/auth", class: "core" },
  { route: "/api/setup", class: "core" },
  { route: "/api/sign-up", class: "core" },
  { route: "/api/password-reset", class: "core" },
  { route: "/api/verify-email", class: "core" },
  { route: "/api/invitations", class: "core" },
  { route: "/api/account", class: "core" },
  { route: "/api/workspaces", class: "core" },
  { route: "/api/operator/v1", class: "core" },
  // The dispatch sweep also moves jobs; it is core and skips the steps of an absent capability (dispatch/sweep.ts).
  { route: "/api/internal/dispatch-sweep", class: "core" },
  { route: "/instance-portal", class: "core" },
  { route: "/api/instance-portal", class: "core" },
  { route: "/w/[workspace]", class: "core" },
  { route: "/api/w/[workspace]", class: "core" },

  // Review: pull requests, projects, runs and everything that feeds or serves a job.
  { route: "/api/webhooks", class: "review" },
  { route: "/api/runners", class: "review" },
  { route: "/api/workers", class: "review" },
  { route: "/api/internal/repository-sync", class: "review" },
  { route: "/projects", class: "review" },
  { route: "/runs", class: "review" },
  { route: "/w/[workspace]/projects", class: "review" },
  { route: "/w/[workspace]/runs", class: "review" },
  { route: "/w/[workspace]/settings/review-defaults", class: "review" },
  { route: "/api/w/[workspace]/repositories", class: "review" },
  { route: "/api/w/[workspace]/review-settings", class: "review" },
  { route: "/api/w/[workspace]/runs", class: "review" },
  { route: "/instance-portal/runs", class: "review" },

  // Billing: payments, balance, rates and everything that only exists while a workspace pays.
  { route: "/api/billing", class: "billing" },
  { route: "/w/[workspace]/settings/billing", class: "billing" },
  { route: "/api/w/[workspace]/billing", class: "billing" },
  { route: "/api/w/[workspace]/llm-key-mode", class: "billing" },
  { route: "/instance-portal/billing", class: "billing" },
  { route: "/api/instance-portal/billing", class: "billing" },
];

const isDynamicSegment = (segment: string) => segment.startsWith("[");

function segmentsOf(route: string): string[] {
  return route.split("/").filter((segment) => segment !== "");
}

/** Whether `entry` covers the route or path given as segments. A dynamic segment of a pattern covers any one segment. */
function covers(entry: RouteEntry, segments: readonly string[]): boolean {
  const pattern = segmentsOf(entry.route);
  if (
    entry.exact === true
      ? segments.length !== pattern.length
      : segments.length < pattern.length
  )
    return false;
  return pattern.every((part, index) => {
    const segment = segments[index];
    if (segment === undefined) return false;
    return isDynamicSegment(part) || part === segment;
  });
}

function specificity(entry: RouteEntry): number {
  const pattern = segmentsOf(entry.route);
  return (
    pattern.length * 2 + pattern.filter((p) => !isDynamicSegment(p)).length
  );
}

/**
 * The class of a route of `src/app` (a file's route, `/w/[workspace]/projects/[repositoryId]`) or of a request path
 * (`/w/acme/projects/42`), or undefined when no pattern covers it.
 */
export function classOfRoute(route: string): RouteClass | undefined {
  const segments = segmentsOf(route);
  let best: RouteEntry | undefined;
  for (const entry of ROUTE_CLASSES) {
    if (!covers(entry, segments)) continue;
    if (best === undefined || specificity(entry) > specificity(best))
      best = entry;
  }
  return best?.class;
}

/**
 * The capability a request path needs, or undefined for a core path and for one the table does not know (it is no route
 * of the app, so it is missing anyway). The admin portal's addresses (`/admin/...`, `/api/admin/...`) are read as the
 * files that serve them. A path that cannot be decoded has no page either.
 */
/**
 * The files that serve an admin address (`/admin/billing` is `/instance-portal/billing`). The same two roots as
 * `portalRewriteTarget` in src/admin/paths.ts (a test keeps them equal); repeated here so that the capability table
 * imports nothing from the admin portal, which imports the capability set.
 */
const ADMIN_SERVED_BY = [
  ["/admin", "/instance-portal"],
  ["/api/admin", "/api/instance-portal"],
] as const;

function servedPath(path: string): string {
  for (const [root, target] of ADMIN_SERVED_BY)
    if (path === root || path.startsWith(`${root}/`))
      return `${target}${path.slice(root.length)}`;
  return path;
}

export function capabilityOfPath(pathname: string): Capability | undefined {
  const path = normalizePath(pathname);
  if (path === null) return undefined;
  const result = classOfRoute(servedPath(path));
  return result === undefined || result === "core" ? undefined : result;
}

/** Whether a request path belongs to a capability this deployment does not have: it answers as a path that is not there. */
export function isAbsentPath(
  pathname: string,
  capabilities: CapabilitySet,
): boolean {
  const needed = capabilityOfPath(pathname);
  return needed !== undefined && !capabilities.has(needed);
}
