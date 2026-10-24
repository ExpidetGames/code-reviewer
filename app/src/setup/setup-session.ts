// SPDX-License-Identifier: LicenseRef-Proprietary

// The setup session: what the browser holds after it entered the correct setup code. A signed cookie
// (HMAC with a key derived for this purpose from the app secret), HttpOnly, SameSite=Strict, Secure
// when the app is served over https, valid for 30 minutes from the moment the code was accepted. It
// is not a stored token: the signature carries the expiry and the id of the issuance of the code it
// belongs to, so a session made by an earlier process (or an earlier code) is worth nothing after a
// restart. When it runs out unfinished the app has to be restarted for a new code.
import { randomBytes } from "node:crypto";
import { signValue, verifySignedValue } from "../crypto/sign.ts";

export const SETUP_SESSION_COOKIE = "cr_setup_session";
export const SETUP_SESSION_TTL_MS = 30 * 60 * 1000;

export type SetupSessionCheck =
  { ok: true } | { ok: false; reason: "missing" | "expired" };

type Payload = { v: 1; issue: string; exp: number; jti: string };

export function createSetupSessionToken(
  appSecret: string,
  issueId: string,
  now: number,
): string {
  const payload: Payload = {
    v: 1,
    issue: issueId,
    exp: now + SETUP_SESSION_TTL_MS,
    jti: randomBytes(12).toString("base64url"),
  };
  return signValue(appSecret, "setup-session", JSON.stringify(payload));
}

function parsePayload(text: string): Payload | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { v, issue, exp, jti } = value as Record<string, unknown>;
    if (
      v !== 1 ||
      typeof issue !== "string" ||
      typeof exp !== "number" ||
      typeof jti !== "string"
    )
      return null;
    return { v, issue, exp, jti };
  } catch {
    return null;
  }
}

/**
 * Whether a cookie value is a valid setup session of the current issuance of the code. A forged,
 * tampered or foreign value is "missing" (the same as no cookie, so nothing is learned from it);
 * only a genuine session that ran out is "expired".
 */
export function checkSetupSession(
  appSecret: string,
  cookieValue: string | undefined,
  currentIssueId: string | null,
  now: number,
): SetupSessionCheck {
  if (cookieValue === undefined || currentIssueId === null)
    return { ok: false, reason: "missing" };
  const text = verifySignedValue(appSecret, "setup-session", cookieValue);
  if (text === null) return { ok: false, reason: "missing" };
  const payload = parsePayload(text);
  if (payload === null || payload.issue !== currentIssueId)
    return { ok: false, reason: "missing" };
  if (now >= payload.exp) return { ok: false, reason: "expired" };
  return { ok: true };
}

/** The `Set-Cookie` value that stores the session. */
export function setupSessionCookie(token: string, secure: boolean): string {
  return [
    `${SETUP_SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${String(SETUP_SESSION_TTL_MS / 1000)}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** The `Set-Cookie` value that removes the session (the setup is complete). */
export function clearedSetupSessionCookie(secure: boolean): string {
  return [
    `${SETUP_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** The value of the setup session cookie in a `Cookie` request header, or undefined. */
export function readSetupSessionCookie(
  cookieHeader: string | null,
): string | undefined {
  if (cookieHeader === null) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SETUP_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}
