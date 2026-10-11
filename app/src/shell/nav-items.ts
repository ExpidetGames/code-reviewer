// The places of the signed in app. One list feeds the navigation, so the labels, the links and the
// active state cannot drift apart.

export const NAV_ITEMS = [
  { href: "/projects", label: "Projects" },
  { href: "/runs", label: "Runs" },
  { href: "/settings", label: "Settings" },
] as const;

export type NavItem = (typeof NAV_ITEMS)[number];

/**
 * Whether `pathname` is on the page `href` or below it (`/runs/42` belongs to `/runs`). A path that
 * only starts with the same letters (`/runs-archive`) does not.
 */
export function isCurrentPage(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
