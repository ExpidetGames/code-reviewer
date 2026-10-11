// Which request paths belong to the admin portal: the pages below `/admin` and the data routes below
// `/api/admin`. The proxy answers 404 for everybody who is not an instance admin (access-proxy.ts),
// so the test has to be wider than the exact spelling: a path is read the way Next.js reads it
// (percent encoding decoded, repeated and trailing slashes and dot segments removed) before it is
// compared, and a path that cannot be read at all counts as an admin path, because it cannot be told
// apart. An admin path that is not recognized would skip the guard in front of the portal.
// (Case is not folded: Next.js routes are case sensitive, so `/ADMIN` is no page at all.)

const ADMIN_ROOTS = ["/admin", "/api/admin"] as const;

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
