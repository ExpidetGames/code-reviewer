// The admin check for the code that runs inside a request: the pages, the data routes. The proxy
// has done the same check first (src/auth/access-proxy.ts); this is the second guard, close to the
// data, because the proxy alone must not be the only one (a changed matcher would silently remove it).
import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { SessionUser } from "../auth/access-policy.ts";
import { getAccessPolicy } from "../auth/access-runtime.ts";
import { getAuth } from "../auth/auth.ts";
import { requireUser } from "../auth/session.ts";
import { lookupSession } from "../auth/session-user.ts";
import { adminAccessOf, type AdminAccess } from "./access.ts";

/** What the current request is: the admin, nobody, or somebody who is not an admin. Never throws for that. */
export async function lookupAdmin(): Promise<AdminAccess> {
  const requestHeaders = await headers();
  return adminAccessOf(
    await lookupSession(getAuth(), requestHeaders, getAccessPolicy()),
  );
}

/**
 * The instance admin of the current request, for a page or a layout. Without a session the person is
 * sent to the sign-in; a signed in person who is not an admin gets the 404 page.
 */
export const requireAdmin = cache(async (): Promise<SessionUser> => {
  const user = await requireUser();
  if (!user.isInstanceAdmin) notFound();
  return user;
});
