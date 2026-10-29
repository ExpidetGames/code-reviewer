// SPDX-License-Identifier: LicenseRef-Proprietary

// The request guard behind `src/proxy.ts`. Every request runs through it (the proxy matcher only
// leaves out Next.js's own static files): a path that is not public needs a valid session, which is
// looked up in the database on each request, so a signed out or expired session stops working at
// once. Anything that goes wrong while checking denies the request.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  PORTAL_DENIED_HEADER,
  PORTAL_REWRITE_HEADER,
  isAdminPath,
  isInternalPortalPath,
  portalRewriteTarget,
} from "../admin/paths.ts";
import {
  legacyWorkspaceTarget,
  workspaceSlugOfPath,
} from "../workspaces/paths.ts";
import { SETUP_REWRITE_HEADER } from "../setup/paths.ts";
import { decideAccess, isNoWorkspacePath, isPublicPath } from "./access.ts";
import type { AccessGates } from "./access-gates.ts";
import type { Auth } from "./auth.ts";
import {
  lookupSession,
  loginPath,
  type SessionLookup,
} from "./session-user.ts";

export { PORTAL_REWRITE_HEADER };

/** SHA-256 of a text: equal in length whatever the text, which is what `timingSafeEqual` needs. */
function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** Whether the request is a browser's navigation (or any client that asks for HTML), not a fetch of the app's own. */
function asksForADocument(request: NextRequest): boolean {
  if (request.headers.get("sec-fetch-dest") === "empty") return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export type AccessProxyDependencies = {
  getAuth: () => Pick<Auth, "api" | "$context">;
  /** The verified-address and workspace gates (access-gates.ts); asked per request. */
  getGates: () => AccessGates;
  /**
   * Whether the path belongs to a capability this deployment does not have (src/capabilities/). Such a path is answered as a
   * path that does not exist, after the same checks any path gets (a visitor without a session is sent to sign in, as for a
   * path that is not there). Left out, no path is absent.
   */
  isAbsent?: (pathname: string) => boolean;
};

export function createAccessProxy({
  getAuth,
  getGates,
  isAbsent = () => false,
}: AccessProxyDependencies) {
  // Per proxy, not per request; a request that comes from outside cannot know it.
  const rewriteMark = randomBytes(24).toString("base64url");
  const rewriteMarkDigest = digest(rewriteMark);

  /** Whether the request carries the mark (compared in constant time, whatever the length of what was sent). */
  function hasRewriteMark(request: NextRequest): boolean {
    const sent = request.headers.get(PORTAL_REWRITE_HEADER);
    if (sent === null) return false;
    return timingSafeEqual(digest(sent), rewriteMarkDigest);
  }

  /**
   * The headers of a request that goes on. The three headers that tell `next.config.ts` what to do with
   * a request are the proxy's alone: one that arrives from outside is taken off every request the proxy
   * sees (not the static files it leaves out, which the rewrites leave out as well), so nobody can have
   * an answer rewritten to a missing path or to the setup page (and a cache between us and them cannot
   * be made to keep that answer), or be served the files of the portal. The portal's header stays on a
   * request that carries the mark. Next.js does not run the proxy again on the path a rewrite of
   * `next.config.ts` leads to, so no request of the proxy's own comes back; the mark is kept for the
   * case that it ever does.
   */
  function cleanedHeaders(request: NextRequest): Headers | null {
    const carriesDenied = request.headers.has(PORTAL_DENIED_HEADER);
    const carriesPortal =
      request.headers.has(PORTAL_REWRITE_HEADER) && !hasRewriteMark(request);
    const carriesSetupRewrite = request.headers.has(SETUP_REWRITE_HEADER);
    if (!carriesDenied && !carriesPortal && !carriesSetupRewrite) return null;
    const headers = new Headers(request.headers);
    headers.delete(PORTAL_DENIED_HEADER);
    headers.delete(SETUP_REWRITE_HEADER);
    if (carriesPortal) headers.delete(PORTAL_REWRITE_HEADER);
    return headers;
  }

  /** Lets the request go on, without the headers that are the proxy's alone. */
  function forward(request: NextRequest): NextResponse {
    const headers = cleanedHeaders(request);
    if (headers === null) return NextResponse.next();
    return NextResponse.next({ request: { headers } });
  }

  /**
   * The files of the portal by their own address are for nobody. The request goes on marked, and
   * `next.config.ts` rewrites a marked request to a path that does not exist, so Next.js answers it itself
   * (a rewrite or a 404 made here would show in the answer, see PORTAL_DENIED_HEADER).
   */
  function treatAsMissing(request: NextRequest): NextResponse {
    const headers = cleanedHeaders(request) ?? new Headers(request.headers);
    headers.set(PORTAL_DENIED_HEADER, "1");
    return NextResponse.next({ request: { headers } });
  }

  return async function accessProxy(
    request: NextRequest,
  ): Promise<NextResponse> {
    const { pathname } = request.nextUrl;

    // A path of a capability this deployment does not have (src/capabilities/) does not exist here. It is answered the way a
    // path that is not a route is: a public prefix (the webhook, the runner API) goes on to the 404 of Next.js, the rest
    // goes through the checks below and ends in the same 404 where it would have been served.
    let absent: boolean;
    try {
      absent = isAbsent(pathname);
    } catch (error) {
      console.error(
        `[auth] could not read the capabilities: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new NextResponse("Service unavailable", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }

    // A public path needs no lookup.
    if (isPublicPath(pathname))
      return absent ? treatAsMissing(request) : forward(request);

    let lookup: SessionLookup;
    try {
      lookup = await lookupSession(getAuth(), request.headers, getGates());
    } catch (error) {
      // The database or the sign in configuration is broken: refuse instead of letting it through.
      console.error(
        `[auth] could not check the session: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new NextResponse("Service unavailable", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }

    // The instance admin whose address is not verified yet keeps the admin portal, so that a problem with
    // the mail server can always be repaired; everything else of the app waits for the verification
    // (src/auth/access-gates.ts). The portal's own files count too: Next.js does not run the proxy on the path a rewrite of next.config.ts
    // leads to, but if it ever does, the request carries the mark.
    // A person without a workspace reaches the few places made for them (access.ts, NO_WORKSPACE_PATHS) and
    // nothing else.
    const signedIn =
      lookup.kind === "user" ||
      (lookup.kind === "no_workspace" && isNoWorkspacePath(pathname)) ||
      (lookup.kind === "unverified" &&
        lookup.user.isInstanceAdmin &&
        (isAdminPath(pathname) || isInternalPortalPath(pathname)))
        ? lookup.user
        : null;

    // A workspace address (`/w/<slug>...`, `/api/w/<slug>...`) is for the members of that workspace. For
    // everybody else it is a path that does not exist: the same answer for a workspace that is not there and
    // one the person does not belong to, so nothing tells them apart. (The pages and routes check the
    // membership again themselves, src/workspaces/access.ts.)
    const workspaceSlug = workspaceSlugOfPath(pathname);
    if (workspaceSlug !== undefined && signedIn !== null) {
      try {
        const role =
          workspaceSlug === null
            ? null
            : await getGates().workspaceRole(signedIn.id, workspaceSlug);
        if (role === null) return treatAsMissing(request);
      } catch (error) {
        console.error(
          `[auth] could not check the workspace: ${error instanceof Error ? error.message : String(error)}`,
        );
        return new NextResponse("Service unavailable", {
          status: 503,
          headers: { "cache-control": "no-store" },
        });
      }
    }

    // An address from before the workspace was in the address (the start page, `/projects`, `/runs/<id>`,
    // `/settings`) leads to the same page of the first workspace of the person, with a real redirect. The
    // page behind it checks the membership like any other. (A person without a workspace, or who has to
    // verify the address, is sent where every other page sends them, below.)
    // Only for a page that is asked for as a document (the address bar, a bookmark, a link from elsewhere):
    // the browser follows a 307 there. The client-side navigation inside the app (a request for the page's
    // data, which Next.js strips its own markers from before the proxy sees it, but which asks for no HTML and
    // says `Sec-Fetch-Dest: empty`) keeps the redirect of the page itself, which the router follows in place; a
    // 307 there makes the router fetch the target twice and the address stays where it was.
    if (
      !absent &&
      lookup.kind === "user" &&
      (request.method === "GET" || request.method === "HEAD") &&
      asksForADocument(request) &&
      legacyWorkspaceTarget(pathname, "x") !== null
    ) {
      let first: string | null;
      try {
        first = await getGates().firstWorkspaceSlug(lookup.user.id);
      } catch (error) {
        console.error(
          `[auth] could not check the workspace: ${error instanceof Error ? error.message : String(error)}`,
        );
        return new NextResponse("Service unavailable", {
          status: 503,
          headers: { "cache-control": "no-store" },
        });
      }
      const target =
        first === null ? null : legacyWorkspaceTarget(pathname, first);
      if (target !== null)
        return NextResponse.redirect(
          new URL(`${target}${request.nextUrl.search}`, request.url),
          307,
        );
    }

    const decision = decideAccess({
      pathname,
      authenticated: signedIn !== null,
    });
    switch (decision.kind) {
      case "allow": {
        if (absent) return treatAsMissing(request);
        // The admin portal (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3). Its files
        // live below `/instance-portal` and `/api/instance-portal`, so `/admin` and `/api/admin` are
        // not routes of the app: the instance admin's request is rewritten to the files, and for
        // everybody else the request goes on as it is and gets the answer of a path that does not
        // exist, with nothing that says the portal is there (src/admin/paths.ts). The pages and routes
        // check again themselves (src/admin/session.ts).
        // The files by their own address are for nobody: not even the admin comes this way. (Only a request
        // with the mark passes, which would be the proxy's own rewrite coming round again; Next.js does not
        // do that for the rewrites of next.config.ts.)
        if (isInternalPortalPath(pathname) && !hasRewriteMark(request))
          return treatAsMissing(request);
        if (signedIn === null) return forward(request);
        if (
          signedIn.isInstanceAdmin &&
          portalRewriteTarget(pathname) !== null
        ) {
          // The request goes on marked and `next.config.ts` serves it from the files of the portal. The
          // proxy builds no address for it: the one Next.js made of the request has the protocol and the
          // host of whatever the client sent as `X-Forwarded-Proto` and `Host`, and a rewrite to an origin
          // other than Next.js's own is a request to another server, which answered 500 here.
          const marked =
            cleanedHeaders(request) ?? new Headers(request.headers);
          marked.set(PORTAL_REWRITE_HEADER, rewriteMark);
          const response = NextResponse.next({ request: { headers: marked } });
          // A portal answer is for the admin alone. A prefetch is answered from Next.js's prerender
          // cache with a year of shared caching (`s-maxage=31536000`), so an admin-only answer must not
          // sit in a shared cache: private and no-store.
          response.headers.set("cache-control", "private, no-store");
          return response;
        }
        return forward(request);
      }
      case "unauthorized":
        // A signed in person who has to verify the address, or has no workspace yet, is known too.
        if (lookup.kind === "unverified")
          return NextResponse.json(
            { error: "email_not_verified" },
            { status: 403, headers: { "cache-control": "no-store" } },
          );
        if (lookup.kind === "no_workspace")
          return NextResponse.json(
            { error: "no_workspace_access" },
            { status: 403, headers: { "cache-control": "no-store" } },
          );
        return NextResponse.json(
          { error: "UNAUTHENTICATED" },
          { status: 401, headers: { "cache-control": "no-store" } },
        );
      case "redirect-to-login":
        // Built from the request's own address, so it is the address the person used.
        return NextResponse.redirect(new URL(loginPath(lookup), request.url), {
          headers: { "cache-control": "no-store" },
        });
    }
  };
}
