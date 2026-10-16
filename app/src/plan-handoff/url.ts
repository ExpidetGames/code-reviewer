// SPDX-License-Identifier: Apache-2.0

// The instance setting `plan_management_url`: the one operator-configured page an Owner or Admin is handed over to
// (README.md). Only an instance admin or the operator API can change it, and what is stored has to pass
// `checkPlanManagementUrl`, so the redirect that follows is never built from a request. The return path of the other
// side is fixed in this app (`return-path.ts`), so there is no open redirect in either direction.

export const PLAN_MANAGEMENT_URL_ERROR_CODES = [
  /** Not a URL, or not an absolute `https://` address in a plain form. */
  "url_invalid",
  /** Any scheme but `https:`. */
  "url_not_https",
  /** A user name or password in the address. */
  "url_has_credentials",
  /** A `#fragment`: the handover carries its token in the query, and a fragment would hide where it lands. */
  "url_has_fragment",
  "url_too_long",
] as const;
export type PlanManagementUrlErrorCode =
  (typeof PLAN_MANAGEMENT_URL_ERROR_CODES)[number];

export const MAX_PLAN_MANAGEMENT_URL_LENGTH = 2048;

/** The query parameter that carries the handoff token to the operator-configured page. */
export const HANDOFF_PARAMETER = "handoff";

export type PlanManagementUrlCheck =
  { ok: true; url: string } | { ok: false; code: PlanManagementUrlErrorCode };

const FORBIDDEN_CHARACTERS = /[\s\u0000-\u001f\u007f\\]/u;

/**
 * Whether `input` may be saved as the plan management page, and the address as it is stored (the normal form the URL
 * parser makes of it). The surrounding white space is ignored; none inside is allowed.
 */
export function checkPlanManagementUrl(input: unknown): PlanManagementUrlCheck {
  if (typeof input !== "string") return { ok: false, code: "url_invalid" };
  const text = input.trim();
  if (text === "") return { ok: false, code: "url_invalid" };
  if (text.length > MAX_PLAN_MANAGEMENT_URL_LENGTH)
    return { ok: false, code: "url_too_long" };
  if (FORBIDDEN_CHARACTERS.test(text))
    return { ok: false, code: "url_invalid" };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, code: "url_invalid" };
  }
  if (parsed.protocol !== "https:") return { ok: false, code: "url_not_https" };
  // `https:example.com` and `https:/example.com` are parsed leniently; only the plain absolute form is stored.
  if (!/^https:\/\/[^/]/iu.test(text))
    return { ok: false, code: "url_invalid" };
  if (parsed.username !== "" || parsed.password !== "")
    return { ok: false, code: "url_has_credentials" };
  if (parsed.hash !== "" || text.includes("#"))
    return { ok: false, code: "url_has_fragment" };
  // The stored form is what is checked again on read: it can be much longer than the text (`ä` is six bytes).
  if (parsed.href.length > MAX_PLAN_MANAGEMENT_URL_LENGTH)
    return { ok: false, code: "url_too_long" };
  return { ok: true, url: parsed.href };
}

/** The address of the redirect: the stored page with the token as its `handoff` parameter (replacing any other). */
export function handoffLocation(
  planManagementUrl: string,
  token: string,
): string {
  const location = new URL(planManagementUrl);
  location.searchParams.set(HANDOFF_PARAMETER, token);
  return location.href;
}
