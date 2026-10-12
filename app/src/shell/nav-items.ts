// SPDX-License-Identifier: Apache-2.0

// The places of the signed in app. One list feeds the navigation, so the labels, the links and the
// active state cannot drift apart. The places belong to a workspace: their addresses are below `/w/<slug>`
// (src/workspaces/paths.ts), and the navigation shows them while the page is in a workspace.
import { workspacePath, workspaceSlugOfPath } from "../workspaces/paths.ts";

export const NAV_PLACES = [
  { path: "/projects", label: "Projects" },
  { path: "/runs", label: "Runs" },
  { path: "/settings", label: "Settings" },
  { path: "/members", label: "Members" },
] as const;

export type NavItem = { href: string; label: string };

/** The places of the workspace the page is in, or none for a page outside any workspace. */
export function navItemsFor(pathname: string | null): NavItem[] {
  const slug = pathname === null ? undefined : workspaceSlugOfPath(pathname);
  if (typeof slug !== "string") return [];
  return NAV_PLACES.map((place) => ({
    href: workspacePath(slug, place.path),
    label: place.label,
  }));
}

/**
 * Whether `pathname` is on the page `href` or below it (`/w/acme/runs/42` belongs to `/w/acme/runs`). A path
 * that only starts with the same letters (`/w/acme/runs-archive`) does not.
 */
export function isCurrentPage(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
