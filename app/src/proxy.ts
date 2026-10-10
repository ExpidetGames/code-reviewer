// Next.js runs this before every route: nothing is reachable without a session except the paths in
// src/auth/access.ts. The logic is in src/auth/access-proxy.ts so it can be tested without a server.
import type { NextRequest } from "next/server";
import { createAccessProxy } from "./auth/access-proxy.ts";
import { getAuth } from "./auth/auth.ts";

const accessProxy = createAccessProxy({ getAuth });

export function proxy(request: NextRequest) {
  return accessProxy(request);
}

export const config = {
  // Everything except Next.js's own static files; "default deny" depends on this matching all.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
