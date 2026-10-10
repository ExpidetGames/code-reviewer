// What the public HTTP interface of Better Auth is allowed to do. Better Auth ships many endpoints
// (list and revoke sessions, update the user, link accounts, ...) that this app neither needs nor
// wants reachable: some would reveal the session token or let a user rewrite their own profile.
// Only the three calls of the GitHub sign in are passed on, everything else is a 404.
import type { Auth } from "./auth.ts";

const AUTH_BASE_PATH = "/api/auth";

type Endpoint = { method: string; path: string };

export const ALLOWED_AUTH_ENDPOINTS: readonly Endpoint[] = [
  // Starts the sign in and returns the GitHub address to go to.
  { method: "POST", path: "/sign-in/social" },
  // Where GitHub sends the person back to.
  { method: "GET", path: "/callback/github" },
  { method: "POST", path: "/sign-out" },
];

export function isAuthEndpointAllowed(
  method: string,
  pathname: string,
): boolean {
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false;
  const path = pathname.slice(AUTH_BASE_PATH.length);
  return ALLOWED_AUTH_ENDPOINTS.some(
    (endpoint) => endpoint.method === method && endpoint.path === path,
  );
}

export function handleAuthRequest(
  auth: Pick<Auth, "handler">,
  request: Request,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!isAuthEndpointAllowed(request.method, pathname))
    return Promise.resolve(
      Response.json({ error: "NOT_FOUND" }, { status: 404 }),
    );
  return auth.handler(request);
}
