// SPDX-License-Identifier: Apache-2.0

// The request guard behind `src/proxy.ts`. Every request runs through it (the proxy matcher only
// leaves out Next.js's own static files): a path that is not public needs a valid session, which is
// looked up in the database on each request, so a signed out or expired session stops working at
// once. Anything that goes wrong while checking denies the request.
import { NextResponse, type NextRequest } from "next/server";
import { decideAccess, isPublicPath } from "./access.ts";
import type { AccessPolicy } from "./access-policy.ts";
import type { Auth } from "./auth.ts";
import {
  lookupSession,
  loginPath,
  type SessionLookup,
} from "./session-user.ts";

export type AccessProxyDependencies = {
  getAuth: () => Pick<Auth, "api" | "$context">;
  /** Called per request, so the policy is created on first use (not when the module is loaded). */
  getPolicy: () => AccessPolicy;
};

export function createAccessProxy({
  getAuth,
  getPolicy,
}: AccessProxyDependencies) {
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
      case "allow":
        return NextResponse.next();
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
