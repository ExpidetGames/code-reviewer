// SPDX-License-Identifier: Apache-2.0

// Checks every state-changing route makes on the request itself, before it reads the body.

// Defense in depth for a session cookie that is `SameSite=Lax` already. Browsers say where a request
// comes from in `Sec-Fetch-Site`; only `same-origin` (and `none`, a request the user typed) is let
// through, so even a sibling subdomain (`same-site`) is refused. A browser that does not send it is
// judged by `Origin` against the host the request was addressed to. A client that sends neither (curl,
// a script) is no browser and can only act with a cookie it already holds.
export function isCrossSite(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null)
    return fetchSite !== "same-origin" && fetchSite !== "none";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // "null" or garbage
  }
}

// A cross-site form can send `text/plain` or form encoded bodies without a preflight, but not
// `application/json`, so insisting on it is a second layer against another site changing something
// with the user's cookie.
export function isJsonRequest(request: Request): boolean {
  const type = request.headers.get("content-type") ?? "";
  return /^application\/json\s*(;|$)/i.test(type);
}
