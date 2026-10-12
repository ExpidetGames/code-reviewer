// SPDX-License-Identifier: Apache-2.0

// The request guard behind `src/proxy.ts`. Every request runs through it (the proxy matcher only
// leaves out Next.js's own static files): a path that is not public needs a valid session, which is
// looked up in the database on each request, so a signed out or expired session stops working at
// once. Anything that goes wrong while checking denies the request.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  PORTAL_DENIED_HEADER,
  isAdminPath,
  isInstanceAdminOnlyPath,
  isInternalPortalPath,
  portalRewriteTarget,
} from "../admin/paths.ts";
import {
  legacyWorkspaceTarget,
  workspaceSlugOfPath,
} from "../workspaces/paths.ts";
import { decideAccess, isNoWorkspacePath, isPublicPath } from "./access.ts";
import type { AccessGates } from "./access-gates.ts";
import type { Auth } from "./auth.ts";
import {
  lookupSession,
  loginPath,
  type SessionLookup,
} from "./session-user.ts";

/**
 * Next.js runs the proxy again on the path a rewrite leads to. The rewrite of the admin's request to the
 * files of the portal carries this header with a value only this process knows, so the second run can
 * tell it from a request that asks for the files by their own address.
 */
export const PORTAL_REWRITE_HEADER = "x-portal-rewrite";

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
};

export function createAccessProxy({
  getAuth,
  getGates,
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
   * Lets the request go on. The header that marks a request for the files of the portal is the proxy's
   * alone: one that arrives from outside is taken off every request the proxy sees (not the static files it
   * leaves out, which the rewrite on the header leaves out as well), so nobody can have an answer rewritten to a
   * missing path (and a cache between us and them cannot be made to keep that answer).
   */
  function forward(request: NextRequest): NextResponse {
    if (!request.headers.has(PORTAL_DENIED_HEADER)) return NextResponse.next();
    const headers = new Headers(request.headers);
    headers.delete(PORTAL_DENIED_HEADER);
    return NextResponse.next({ request: { headers } });
  }

  /**
   * The files of the portal by their own address are for nobody. The request goes on marked, and
   * `next.config.ts` rewrites a marked request to a path that does not exist, so Next.js answers it itself
   * (a rewrite or a 404 made here would show in the answer, see PORTAL_DENIED_HEADER).
   */
  function treatAsMissing(request: NextRequest): NextResponse {
    const headers = new Headers(request.headers);
    headers.set(PORTAL_DENIED_HEADER, "1");
    return NextResponse.next({ request: { headers } });
  }

  return async function accessProxy(
    request: NextRequest,
  ): Promise<NextResponse> {
    const { pathname } = request.nextUrl;

    // A public path needs no lookup.
    if (isPublicPath(pathname)) return forward(request);

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

    // What is about the instance and not about a workspace (the backup status) is for the instance admin. For
    // every other person who is let into the app it is a path that does not exist, whatever their role in a
    // workspace is: the same answer, so nothing says the route is there. (A person who still has to verify
    // the address or has no workspace gets the answer every other path gets, below.)
    if (
      isInstanceAdminOnlyPath(pathname) &&
      lookup.kind === "user" &&
      !lookup.user.isInstanceAdmin
    )
      return treatAsMissing(request);

    // The instance admin whose address is not verified yet keeps the admin portal, so that a problem with
    // the mail server can always be repaired; everything else of the app waits for the verification
    // (src/auth/access-gates.ts). The portal's own files count, because a rewrite runs the proxy again.
    // A person without a workspace reaches the few places made for them (access.ts, NO_WORKSPACE_PATHS) and
    // nothing else.
    const signedIn =
      lookup.kind === "user" ||
      (lookup.kind === "no_workspace" && isNoWorkspacePath(pathname)) ||
      (lookup.kind === "unverified" &&
        lookup.user.isInstanceAdmin &&
        (isAdminPath(pathname) ||
          isInternalPortalPath(pathname) ||
          isInstanceAdminOnlyPath(pathname)))
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
        // The admin portal (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3). Its files
        // live below `/instance-portal` and `/api/instance-portal`, so `/admin` and `/api/admin` are
        // not routes of the app: the instance admin's request is rewritten to the files, and for
        // everybody else the request goes on as it is and gets the answer of a path that does not
        // exist, with nothing that says the portal is there (src/admin/paths.ts). The pages and routes
        // check again themselves (src/admin/session.ts).
        // The files by their own address are for nobody: not even the admin comes this way. (The admin's
        // own rewrite arrives here once more, with the mark.)
        if (isInternalPortalPath(pathname) && !hasRewriteMark(request))
          return treatAsMissing(request);
        if (signedIn === null) return forward(request);
        const target = signedIn.isInstanceAdmin
          ? portalRewriteTarget(pathname)
          : null;
        if (target !== null) {
          const marked = new Headers(request.headers);
          marked.delete(PORTAL_DENIED_HEADER);
          marked.set(PORTAL_REWRITE_HEADER, rewriteMark);
          return NextResponse.rewrite(
            new URL(`${target}${request.nextUrl.search}`, request.url),
            { request: { headers: marked } },
          );
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
