// SPDX-License-Identifier: LicenseRef-Proprietary

// The PostHog identity a visitor of code-review.com brings to the app (#692). A visitor who accepted tracking on the
// landing page follows links to `/sign-up` and `/login` that carry the PostHog distinct id (`ph_did`) and session id
// (`ph_sid`). The app only keeps them on the user it creates or signs in; it never loads PostHog and never uses them for
// anything. They are opaque text from outside, so only a plain shape is accepted (PostHog ids are UUIDs, or hyphenated
// hex groups in older SDKs) and everything else is ignored without a word.
//
// Between the page and the sign-in they travel in one short-lived first-party cookie (`cookie.ts`), `<did>~<sid>`.

/** The query parameters of the landing page's links. */
export const LANDING_IDENTITY_PARAMS = {
  distinctId: "ph_did",
  sessionId: "ph_sid",
} as const;

/** The first-party cookie that carries the identity from the page to the sign-in. HttpOnly, never read by a script. */
export const LANDING_IDENTITY_COOKIE = "cr-landing";

/** How long the cookie lives: long enough for a sign-in (GitHub included), short enough to be gone with the visit. */
export const LANDING_IDENTITY_MAX_AGE_SECONDS = 60 * 60;

export const LANDING_ID_MAX_LENGTH = 200;

/** Letters, digits and `. _ : -` only: no white space, quote, slash, separator of the cookie or encoding. */
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

/** What was brought along: at least one identifier is set. */
export type LandingIdentity = {
  distinctId: string | null;
  sessionId: string | null;
};

/** The identifier if the value has the accepted shape, else null. */
export function validLandingId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > LANDING_ID_MAX_LENGTH) return null;
  return SAFE_ID.test(value) ? value : null;
}

function identityOf(
  distinctId: string | null,
  sessionId: string | null,
): LandingIdentity | null {
  return distinctId === null && sessionId === null
    ? null
    : { distinctId, sessionId };
}

/** The identity in the query of a request to `/sign-up` or `/login`, or null when there is none worth keeping. */
export function landingIdentityFromSearchParams(
  params: URLSearchParams,
): LandingIdentity | null {
  return identityOf(
    validLandingId(params.get(LANDING_IDENTITY_PARAMS.distinctId)),
    validLandingId(params.get(LANDING_IDENTITY_PARAMS.sessionId)),
  );
}

/** The value of the cookie. */
export function encodeLandingIdentity(identity: LandingIdentity): string {
  return `${identity.distinctId ?? ""}~${identity.sessionId ?? ""}`;
}

function decodeLandingIdentity(value: string): LandingIdentity | null {
  const parts = value.split("~");
  if (parts.length !== 2) return null;
  const [rawDistinct = "", rawSession = ""] = parts;
  // Strict: a part is empty or valid. The cookie is ours, so anything else is a cookie somebody wrote by hand.
  const distinctId = rawDistinct === "" ? null : validLandingId(rawDistinct);
  const sessionId = rawSession === "" ? null : validLandingId(rawSession);
  if (rawDistinct !== "" && distinctId === null) return null;
  if (rawSession !== "" && sessionId === null) return null;
  return identityOf(distinctId, sessionId);
}

/** The identity in the `Cookie` header of a request, or null. */
export function landingIdentityFromCookieHeader(
  header: string | null | undefined,
): LandingIdentity | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== LANDING_IDENTITY_COOKIE) continue;
    return decodeLandingIdentity(part.slice(separator + 1).trim());
  }
  return null;
}

/** A `Set-Cookie` line that removes the cookie from the browser (the identity is stored, the cookie did its job). */
export function clearedLandingIdentityCookie(): string {
  return `${LANDING_IDENTITY_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/** Whether the request carries the cookie at all, valid or not. */
export function carriesLandingIdentityCookie(
  header: string | null | undefined,
): boolean {
  if (!header) return false;
  return header
    .split(";")
    .some((part) => part.trim().startsWith(`${LANDING_IDENTITY_COOKIE}=`));
}
