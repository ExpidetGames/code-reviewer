// SPDX-License-Identifier: LicenseRef-Proprietary

// The proxy's step for a visitor who comes from code-review.com (#692). A link of the landing page to `/sign-up` or `/login`
// carries the PostHog identifiers (`ph_did`, `ph_sid`, see identity.ts) when the visitor accepted tracking there. This puts
// the valid ones into one first-party cookie (HttpOnly, SameSite=Lax, one hour) so they survive the sign-in, the redirect to
// GitHub and the way back, and takes both parameters out of the address with a redirect, so they are not in the address bar,
// the history or a later Referer. An invalid value is dropped without a word. Nothing here decides anything about the
// request; the values are never trusted for anything.
import { NextResponse, type NextRequest } from "next/server";
import {
  LANDING_IDENTITY_COOKIE,
  LANDING_IDENTITY_MAX_AGE_SECONDS,
  LANDING_IDENTITY_PARAMS,
  encodeLandingIdentity,
  landingIdentityFromSearchParams,
} from "./identity.ts";

/** The two pages the landing page links to. */
const LANDING_PATHS: ReadonlySet<string> = new Set(["/sign-up", "/login"]);

export type CaptureOptions = {
  /** Whether the cookie gets `Secure`: exactly when the app is served over https. Asked only for a request this acts on. */
  secure: () => boolean;
};

/** The redirect that sets the cookie and cleans the address, or null when the request is none of the landing page's. */
export function captureLandingIdentity(
  request: NextRequest,
  { secure }: CaptureOptions,
): NextResponse | null {
  if (request.method !== "GET") return null;
  const { pathname, searchParams } = request.nextUrl;
  if (!LANDING_PATHS.has(pathname)) return null;
  const carriesParameter = Object.values(LANDING_IDENTITY_PARAMS).some((name) =>
    searchParams.has(name),
  );
  if (!carriesParameter) return null;

  const identity = landingIdentityFromSearchParams(searchParams);
  const clean = new URL(request.url);
  for (const name of Object.values(LANDING_IDENTITY_PARAMS))
    clean.searchParams.delete(name);
  const response = NextResponse.redirect(clean, 307);
  // The answer depends on the parameters and sets a cookie: nothing in between keeps it.
  response.headers.set("cache-control", "no-store");
  if (identity !== null)
    response.cookies.set(
      LANDING_IDENTITY_COOKIE,
      encodeLandingIdentity(identity),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: secure(),
        path: "/",
        maxAge: LANDING_IDENTITY_MAX_AGE_SECONDS,
      },
    );
  return response;
}
