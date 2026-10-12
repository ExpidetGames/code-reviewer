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
  isInternalPortalPath,
  portalRewriteTarget,
} from "../admin/paths.ts";
import { decideAccess, isPublicPath } from "./access.ts";
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

    // The instance admin whose address is not verified yet keeps the admin portal, so that a problem with
    // the mail server can always be repaired; everything else of the app waits for the verification
    // (src/auth/access-gates.ts). The portal's own files count, because a rewrite runs the proxy again.
    const signedIn =
      lookup.kind === "user" ||
      (lookup.kind === "unverified" &&
        lookup.user.isInstanceAdmin &&
        (isAdminPath(pathname) || isInternalPortalPath(pathname)))
        ? lookup.user
        : null;

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
