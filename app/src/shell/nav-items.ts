// SPDX-License-Identifier: Apache-2.0

// The places of the signed in app, grouped the way the sidebar shows them. One list feeds the
// navigation, so the labels, the links and the active state cannot drift apart. The places belong to
// a workspace: their addresses are below `/w/<slug>` (src/workspaces/paths.ts), and the navigation
// shows them while the page is in a workspace. The groups are daily work (Projects, Runs), then a
// separator, then the workspace administration (Connections, Members, Settings); #168 says Members
// stays a top-level item.
import { workspacePath, workspaceSlugOfPath } from "../workspaces/paths.ts";

const NAV_GROUPS = [
  {
    items: [
      { path: "/projects", label: "Projects" },
      { path: "/runs", label: "Runs" },
    ],
  },
  {
    items: [
      { path: "/connections", label: "Connections" },
      { path: "/members", label: "Members" },
      { path: "/settings", label: "Settings" },
    ],
  },
] as const;

export type NavItem = { href: string; label: string };
/** A group of places; the sidebar draws a separator between two groups, not inside one. */
export type NavGroup = { items: NavItem[] };

/**
 * The class of a sidebar link, shared by the workspace and the admin sidebar: the token colour, an
 * underline only for the current page (`aria-current`), and a 44px row on a touch screen while the
 * kit's 32px (`h-8`) stays on a fine pointer (`components/README.md`, "Hit areas").
 */
export const SIDEBAR_LINK_CLASS =
  "text-sidebar-foreground no-underline aria-[current=page]:underline pointer-coarse:h-11";

/** The groups of the workspace the page is in, or none for a page outside any workspace. */
export function navGroupsFor(pathname: string | null): NavGroup[] {
  const slug = pathname === null ? undefined : workspaceSlugOfPath(pathname);
  if (typeof slug !== "string") return [];
  return NAV_GROUPS.map((group) => ({
    items: group.items.map((place) => ({
      href: workspacePath(slug, place.path),
      label: place.label,
    })),
  }));
}

/** Every place in one list, in the order the sidebar shows them. */
export function navItemsFor(pathname: string | null): NavItem[] {
  return navGroupsFor(pathname).flatMap((group) => group.items);
}

/**
 * Whether `pathname` is on the page `href` or below it (`/w/acme/runs/42` belongs to `/w/acme/runs`). A path
 * that only starts with the same letters (`/w/acme/runs-archive`) does not.
 */
export function isCurrentPage(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
