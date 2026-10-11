// The signed in user for pages and server actions. The proxy has already turned away a request
// without a session; this is the second check, close to the data, because the proxy alone must not
// be the only guard (a changed matcher would silently remove it).
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { SessionUser } from "./access-policy.ts";
import { getAccessPolicy } from "./access-runtime.ts";
import { getAuth } from "./auth.ts";
import { loginPath, lookupSession } from "./session-user.ts";

/**
 * The user of the current request. Without a valid session the person is sent to the login page.
 * Cached per request (React `cache`): a layout and the page below it run side by side and both
 * ask, but the session and the access policy (which may ask GitHub) are looked up once.
 */
export const requireUser = cache(async (): Promise<SessionUser> => {
  // Read the request first: that is what keeps this out of the static shell. Opening the auth
  // instance (and so the database) before it would run at build time.
  const requestHeaders = await headers();
  const lookup = await lookupSession(
    getAuth(),
    requestHeaders,
    getAccessPolicy(),
  );
  if (lookup.kind !== "user") redirect(loginPath(lookup));
  return lookup.user;
});
