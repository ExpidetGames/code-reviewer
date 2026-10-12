// SPDX-License-Identifier: Apache-2.0

// The admin check for the code that runs inside a request: the pages, the data routes. The proxy
// has done the same check first (src/auth/access-proxy.ts); this is the second guard, close to the
// data, because the proxy alone must not be the only one (a changed matcher would silently remove it).
import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { getAccessGates } from "../auth/access-gates-runtime.ts";
import type { SessionUser } from "../auth/access-policy.ts";
import { getAccessPolicy } from "../auth/access-runtime.ts";
import { getAuth } from "../auth/auth.ts";
import { currentLookup } from "../auth/session.ts";
import { loginPath, lookupSession } from "../auth/session-user.ts";
import { adminAccessOf, type AdminAccess } from "./access.ts";

/** What the current request is: the admin, nobody, or somebody who is not an admin. Never throws for that. */
export async function lookupAdmin(): Promise<AdminAccess> {
  const requestHeaders = await headers();
  return adminAccessOf(
    await lookupSession(
      getAuth(),
      requestHeaders,
      getAccessPolicy(),
      getAccessGates(),
    ),
  );
}

/** The id of the session of the current request, or null. A state that travels through GitHub is bound to it. */
export async function lookupSessionId(): Promise<string | null> {
  try {
    const session = await getAuth().api.getSession({
      headers: await headers(),
    });
    return session?.session.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The instance admin of the current request, for a page or a layout. Without a session the person is
 * sent to the sign-in; a signed in person who is not an instance admin gets the 404 page. The admin
 * whose address is not verified yet is still the admin: the portal is where the mail server is
 * repaired (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3).
 */
export const requireAdmin = cache(async (): Promise<SessionUser> => {
  const lookup = await currentLookup();
  const access = adminAccessOf(lookup);
  if (access.kind === "anonymous") redirect(loginPath(lookup));
  if (access.kind === "not_admin") notFound();
  return access.user;
});
