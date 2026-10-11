// SPDX-License-Identifier: Apache-2.0

// Which request paths belong to the admin portal: the pages below `/admin` and the data routes below
// `/api/admin`. Those paths are not routes of the app: the files of the portal live below
// `/instance-portal` and `/api/instance-portal`, and the proxy (access-proxy.ts) rewrites the request
// of the instance admin there. For everybody else the portal paths are really missing, so the answer is
// the one of any path that does not exist, in every detail (a rewrite or a 404 built by hand would
// show: Next.js adds rewrite headers, and prerenders its own not-found with other caching).
// The test for a portal path has to be wider than the exact spelling: a path is read the way Next.js reads it
// (percent encoding decoded, repeated and trailing slashes and dot segments removed) before it is
// compared, and a path that cannot be read at all counts as an admin path, because it cannot be told
// apart. An admin path that is not recognized would skip the guard in front of the portal.
// (Case is not folded: Next.js routes are case sensitive, so `/ADMIN` is no page at all.)

const ADMIN_ROOTS = ["/admin", "/api/admin"] as const;

/** Where the pages and the data routes of the portal live. Not addresses anybody uses. */
export const PORTAL_PAGE_ROOT = "/instance-portal";
export const PORTAL_API_ROOT = "/api/instance-portal";
/** A path that is no route of the app, and never will be. */
export const MISSING_PATH = "/page-not-found-a41e0c";

/** The path as the router sees it, or null when it cannot be decoded. */
function normalize(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export function isAdminPath(pathname: string): boolean {
  const path = normalize(pathname);
  // Cannot be read: the router will not find a page for it either, but it must not be waved through.
  if (path === null) return true;
  return ADMIN_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

/**
 * The route that serves a portal path: `/admin/setup` is `/instance-portal/setup`, `/api/admin/settings`
 * is `/api/instance-portal/settings`, whatever the spelling. Null for a path that is not one, or that
 * cannot be read (it is then no route either).
 */
export function portalRewriteTarget(pathname: string): string | null {
  const path = normalize(pathname);
  if (path === null) return null;
  for (const [root, target] of [
    ["/admin", PORTAL_PAGE_ROOT],
    ["/api/admin", PORTAL_API_ROOT],
  ] as const)
    if (path === root || path.startsWith(`${root}/`))
      return `${target}${path.slice(root.length)}`;
  return null;
}

/**
 * Whether a request asks for the files of the portal by their own address. Nobody does: the instance
 * admin comes as `/admin`. It is answered as a missing path for everybody, so the portal cannot be
 * reached, or recognized, by this way.
 */
export function isInternalPortalPath(pathname: string): boolean {
  const path = normalize(pathname);
  if (path === null) return false;
  return [PORTAL_PAGE_ROOT, PORTAL_API_ROOT].some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}
