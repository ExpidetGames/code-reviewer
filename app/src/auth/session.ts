// SPDX-License-Identifier: LicenseRef-Proprietary

// The signed in user for pages and server actions. The proxy has already turned away a request
// without a session; this is the second check, close to the data, because the proxy alone must not
// be the only guard (a changed matcher would silently remove it).
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAccessGates } from "./access-gates-runtime.ts";
import type { SessionUser } from "./access-policy.ts";
import { getAuth } from "./auth.ts";
import {
  loginPath,
  lookupSession,
  type SessionLookup,
} from "./session-user.ts";

/**
 * What the current request is signed in as (see `SessionLookup`). Cached per request (React `cache`):
 * a layout and the page below it run side by side and both ask, but the session and the gates are
 * looked up once.
 */
export const currentLookup = cache(async (): Promise<SessionLookup> => {
  // Read the request first: that is what keeps this out of the static shell. Opening the auth
  // instance (and so the database) before it would run at build time.
  const requestHeaders = await headers();
  return lookupSession(getAuth(), requestHeaders, getAccessGates());
});

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
 * The user of the current request, who may use the app. Without a valid session the person is sent
 * to the login page; somebody who still has to verify the address, or who has no workspace, to the
 * page that says so.
 */
export const requireUser = cache(async (): Promise<SessionUser> => {
  const lookup = await currentLookup();
  if (lookup.kind !== "user") redirect(loginPath(lookup));
  return lookup.user;
});

/**
 * Whoever is signed in, whether or not they may use the app yet: for the frame around a page (the user
 * menu with its sign out), never for what a page shows. The page itself calls `requireUser()`.
 */
export const requireSignedIn = cache(async (): Promise<SessionUser> => {
  const lookup = await currentLookup();
  if (lookup.kind === "none") redirect(loginPath(lookup));
  return lookup.user;
});
