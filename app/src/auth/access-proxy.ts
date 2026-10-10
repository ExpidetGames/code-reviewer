// The request guard behind `src/proxy.ts`. Every request runs through it (the proxy matcher only
// leaves out Next.js's own static files): a path that is not public needs a valid session, which is
// looked up in the database on each request, so a signed out or expired session stops working at
// once. Anything that goes wrong while checking denies the request.
import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "./access.ts";
import { accessPolicy, type AccessPolicy } from "./access-policy.ts";
import type { Auth } from "./auth.ts";
import { getSessionUser } from "./session-user.ts";

export type AccessProxyDependencies = {
  getAuth: () => Pick<Auth, "api">;
  policy?: AccessPolicy;
};

export function createAccessProxy({
  getAuth,
  policy = accessPolicy,
}: AccessProxyDependencies) {
  return async function accessProxy(
    request: NextRequest,
  ): Promise<NextResponse> {
    const { pathname } = request.nextUrl;

    // A public path needs no lookup.
    if (decideAccess({ pathname, authenticated: false }).kind === "allow")
      return NextResponse.next();

    let authenticated: boolean;
    try {
      authenticated =
        (await getSessionUser(getAuth(), request.headers, policy)) !== null;
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

    const decision = decideAccess({ pathname, authenticated });
    switch (decision.kind) {
      case "allow":
        return NextResponse.next();
      case "unauthorized":
        return NextResponse.json(
          { error: "UNAUTHENTICATED" },
          { status: 401, headers: { "cache-control": "no-store" } },
        );
      case "redirect-to-login":
        // Built from the request's own address, so it is the address the person used.
        return NextResponse.redirect(new URL("/login", request.url), {
          headers: { "cache-control": "no-store" },
        });
    }
  };
}
