// The signed in user for pages and server actions. The proxy has already turned away a request
// without a session; this is the second check, close to the data, because the proxy alone must not
// be the only guard (a changed matcher would silently remove it).
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { SessionUser } from "./access-policy.ts";
import { getAuth } from "./auth.ts";
import { getSessionUser } from "./session-user.ts";

/** The user of the current request. Without a valid session the person is sent to the login page. */
export async function requireUser(): Promise<SessionUser> {
  // Read the request first: that is what keeps this out of the static shell. Opening the auth
  // instance (and so the database) before it would run at build time.
  const requestHeaders = await headers();
  const user = await getSessionUser(getAuth(), requestHeaders);
  if (!user) redirect("/login");
  return user;
}
