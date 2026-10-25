// SPDX-License-Identifier: LicenseRef-Proprietary

// The PostHog identity a visitor of code-review.com brings to the app (#692). A visitor who accepted tracking on the
// landing page follows links to `/sign-up` and `/login` that carry the PostHog distinct id (`ph_did`) and session id
// (`ph_sid`). The app only keeps them on the user it creates or signs in; it never loads PostHog and never uses them for
// anything. They are opaque text from outside, so only a plain shape is accepted (PostHog ids are UUIDs, or hyphenated
// hex groups in older SDKs) and everything else is ignored without a word.
//
// Between the page and the sign-in they travel in one short-lived first-party cookie (set by `capture.ts`), `<did>~<sid>`.
// The cookie is a hint, not a fact: anyone can plant the values by sending a link, so what is stored from it is an
// untrusted attribution note (see the README).

/** The query parameters of the landing page's links. */
export const LANDING_IDENTITY_PARAMS = {
  distinctId: "ph_did",
  sessionId: "ph_sid",
  /**
   * When the landing page decorated the link. Only taken out of the address (with the other two), never stored and never
   * checked: how fresh a link is, is the landing page's rule, and the identifiers are not trusted for anything anyway.
   */
  decoratedAt: "ph_ts",
} as const;

/**
 * The first-party cookie that carries the identity from the page to the sign-in. HttpOnly, never read by a script. This is
 * its name over plain http (development, tests); over https it is `LANDING_IDENTITY_HOST_COOKIE`.
 */
export const LANDING_IDENTITY_COOKIE = "cr-landing";

/**
 * Over https the cookie carries the `__Host-` prefix: the browser then only takes it with `Secure`, `Path=/` and no
 * `Domain`, so no sibling subdomain can set or shadow it.
 */
export const LANDING_IDENTITY_HOST_COOKIE = `__Host-${LANDING_IDENTITY_COOKIE}`;

/** The name the cookie is set under: with the prefix exactly when it is `Secure`. */
export function landingIdentityCookieName(secure: boolean): string {
  return secure ? LANDING_IDENTITY_HOST_COOKIE : LANDING_IDENTITY_COOKIE;
}

/** Both names, the one a request over https carries first. */
const COOKIE_NAMES = [LANDING_IDENTITY_HOST_COOKIE, LANDING_IDENTITY_COOKIE];

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

/** The raw value of the named cookie in a `Cookie` header, or undefined. */
function cookieValue(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** The identity in the `Cookie` header of a request, or null. */
export function landingIdentityFromCookieHeader(
  header: string | null | undefined,
): LandingIdentity | null {
  if (!header) return null;
  for (const name of COOKIE_NAMES) {
    const raw = cookieValue(header, name);
    if (raw === undefined) continue;
    // Next's cookie API percent-encodes the value it sets (`:` becomes `%3A`), so it is decoded before it is checked.
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return null;
    }
    return decodeLandingIdentity(value);
  }
  return null;
}

/** The names of the cookie the request carries (normally none or one). */
export function carriedLandingIdentityCookieNames(
  header: string | null | undefined,
): string[] {
  if (!header) return [];
  return COOKIE_NAMES.filter((name) => cookieValue(header, name) !== undefined);
}

/** `Set-Cookie` lines that remove the cookie(s) the request carried (the identity is stored, the cookie did its job). */
export function clearedLandingIdentityCookies(
  header: string | null | undefined,
): string[] {
  return carriedLandingIdentityCookieNames(header).map((name) =>
    name === LANDING_IDENTITY_HOST_COOKIE
      ? // A browser refuses even the removal of a `__Host-` cookie that does not say `Secure`.
        `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`
      : `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
}

/** Whether the request carries the cookie at all, valid or not. */
export function carriesLandingIdentityCookie(
  header: string | null | undefined,
): boolean {
  return carriedLandingIdentityCookieNames(header).length > 0;
}
