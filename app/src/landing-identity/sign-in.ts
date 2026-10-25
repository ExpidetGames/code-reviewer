// SPDX-License-Identifier: LicenseRef-Proprietary

// The landing identity at a sign in (#692). Better Auth calls this after it has made a session, for every way of signing in
// (the callback of GitHub, the email form), for a new account and a known one alike. If the browser carries the cookie of
// `capture.ts`, its identifiers are stored on the user while the user has none (store.ts), and the cookie is cleared: it
// did its one job, and a later sign in on the same browser must not carry it. Never throws: the identity is a note for the
// owner, and a failure must not cost anybody their sign in; it is logged by its name only, never with a value.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import {
  LANDING_IDENTITY_COOKIE,
  landingIdentityFromCookieHeader,
} from "./identity.ts";
import { recordLandingIdentity } from "./store.ts";

/** The part of Better Auth's endpoint context this needs. */
export type SignInContext = {
  headers?: Headers;
  request?: Request;
  setCookie: (
    name: string,
    value: string,
    options?: { path?: string; maxAge?: number },
  ) => unknown;
};

export async function captureLandingIdentityAtSignIn(
  db: Kysely<Database>,
  userId: string,
  context: SignInContext | null,
  log: (message: string) => void = console.error,
): Promise<void> {
  if (context === null) return;
  const header =
    context.headers?.get("cookie") ??
    context.request?.headers.get("cookie") ??
    null;
  // Nothing to do for a request without the cookie: the usual case costs no query.
  if (header === null || !header.includes(LANDING_IDENTITY_COOKIE)) return;
  try {
    const identity = landingIdentityFromCookieHeader(header);
    if (identity !== null) await recordLandingIdentity(db, userId, identity);
    context.setCookie(LANDING_IDENTITY_COOKIE, "", { path: "/", maxAge: 0 });
  } catch (error) {
    log(
      `[auth] LANDING_IDENTITY_FAILED: the landing identity could not be stored (${error instanceof Error ? error.name : "error"}).`,
    );
  }
}
