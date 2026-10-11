// SPDX-License-Identifier: Apache-2.0

// Which paths need a session. Pure functions so the rule is easy to test: `proxy.ts` only wires
// them to Next.js. The rule is default deny: a path is open only when it is on PUBLIC_PATHS, so a
// route added later is protected until somebody decides otherwise here.

type PublicPath = {
  path: string;
  /** "exact": only this path. "prefix": this path and everything below it, on a segment boundary. */
  match: "exact" | "prefix";
};

export const PUBLIC_PATHS: readonly PublicPath[] = [
  { path: "/login", match: "exact" },
  { path: "/api/health", match: "exact" },
  // The first-run setup. It has its own protection (the setup code and the setup session, see
  // src/setup/), and it exists only while the instance is not set up: the setup gate in front of this
  // check (src/setup/gate.ts) answers 404 for these paths once it is.
  { path: "/setup", match: "exact" },
  { path: "/api/setup", match: "prefix" },
  // Better Auth: sign in, the OAuth callback, sign out.
  { path: "/api/auth", match: "prefix" },
  // The runner authenticates with its own shared token, not with a session.
  { path: "/api/runners", match: "prefix" },
  // GitHub authenticates a webhook with its signature, not with a session.
  { path: "/api/webhooks", match: "prefix" },
];

/**
 * `pathname` is the path of the request URL as Next.js hands it to the proxy: dot segments are
 * resolved, percent encoding is untouched, case is kept. Anything that merely looks like a public
 * path (other case, extra slash, encoded letters, a longer name) is not public, so an odd spelling
 * can only lock a request out, never let it in.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(({ path, match }) =>
    match === "exact"
      ? pathname === path
      : pathname === path || pathname.startsWith(`${path}/`),
  );
}

export type AccessDecision =
  { kind: "allow" } | { kind: "redirect-to-login" } | { kind: "unauthorized" };

export function decideAccess({
  pathname,
  authenticated,
}: {
  pathname: string;
  authenticated: boolean;
}): AccessDecision {
  if (authenticated || isPublicPath(pathname)) return { kind: "allow" };
  if (pathname === "/api" || pathname.startsWith("/api/"))
    return { kind: "unauthorized" };
  return { kind: "redirect-to-login" };
}
