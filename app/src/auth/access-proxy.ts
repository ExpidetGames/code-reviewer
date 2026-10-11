// SPDX-License-Identifier: Apache-2.0

// The request guard behind `src/proxy.ts`. Every request runs through it (the proxy matcher only
// leaves out Next.js's own static files): a path that is not public needs a valid session, which is
// looked up in the database on each request, so a signed out or expired session stops working at
// once. Anything that goes wrong while checking denies the request.
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  MISSING_PATH,
  isInternalPortalPath,
  portalRewriteTarget,
} from "../admin/paths.ts";
import { decideAccess, isPublicPath } from "./access.ts";
import type { AccessPolicy } from "./access-policy.ts";
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

export type AccessProxyDependencies = {
  getAuth: () => Pick<Auth, "api" | "$context">;
  /** Called per request, so the policy is created on first use (not when the module is loaded). */
  getPolicy: () => AccessPolicy;
};

export function createAccessProxy({
  getAuth,
  getPolicy,
}: AccessProxyDependencies) {
  // Per proxy, not per request; a request that comes from outside cannot know it.
  const rewriteMark = randomBytes(24).toString("base64url");

  return async function accessProxy(
    request: NextRequest,
  ): Promise<NextResponse> {
    const { pathname } = request.nextUrl;

    // A public path needs no lookup.
    if (isPublicPath(pathname)) return NextResponse.next();

    let lookup: SessionLookup;
    try {
      lookup = await lookupSession(getAuth(), request.headers, getPolicy());
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

    const decision = decideAccess({
      pathname,
      authenticated: lookup.kind === "user",
    });
    switch (decision.kind) {
      case "allow": {
        // The admin portal (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3). Its files
        // live below `/instance-portal` and `/api/instance-portal`, so `/admin` and `/api/admin` are
        // not routes of the app: the instance admin's request is rewritten to the files, and for
        // everybody else the request goes on as it is and gets the answer of a path that does not
        // exist, with nothing that says the portal is there (src/admin/paths.ts). The pages and routes
        // check again themselves (src/admin/session.ts).
        if (lookup.kind !== "user") return NextResponse.next();
        // The files by their own address are for nobody: not even the admin comes this way. (The admin's
        // own rewrite arrives here once more, with the mark.)
        if (
          isInternalPortalPath(pathname) &&
          request.headers.get(PORTAL_REWRITE_HEADER) !== rewriteMark
        )
          return NextResponse.rewrite(new URL(MISSING_PATH, request.url));
        const target = lookup.user.isInstanceAdmin
          ? portalRewriteTarget(pathname)
          : null;
        if (target !== null) {
          const marked = new Headers(request.headers);
          marked.set(PORTAL_REWRITE_HEADER, rewriteMark);
          return NextResponse.rewrite(
            new URL(`${target}${request.nextUrl.search}`, request.url),
            { request: { headers: marked } },
          );
        }
        return NextResponse.next();
      }
      case "unauthorized":
        // A user the policy turned away is known, so the answer is "forbidden", with the reason.
        if (lookup.kind === "denied")
          return NextResponse.json(
            { error: "ACCESS_DENIED", reason: lookup.reason },
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
