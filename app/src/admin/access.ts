// SPDX-License-Identifier: LicenseRef-Proprietary

// Who may use the admin portal: the signed in instance admin, and nobody else. A person who is not
// signed in is sent to the sign-in (a page) or gets 401 (a data route); a signed in person who is not
// an instance admin gets the same 404 as for a path that does not exist, so nothing says that the
// portal is there. The check reads the admin flag of the user from the database on every request
// (the session lookup does), so taking the flag away takes effect at once.
//
// The admin keeps access when the email address is not verified: a problem with the mail server must
// always be fixable (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3). So nothing
// here looks at `email_verified`.
import type { SessionUser } from "../auth/access-policy.ts";
import type { SessionLookup } from "../auth/session-user.ts";

export type AdminAccess =
  | { kind: "admin"; user: SessionUser }
  | { kind: "anonymous" }
  | { kind: "not_admin" };

/**
 * An admin who still has to verify the address is the admin all the same, and somebody who is not an
 * admin gets the answer of a missing path whether or not their address is verified or they have a
 * workspace.
 */
export function adminAccessOf(lookup: SessionLookup): AdminAccess {
  if (lookup.kind === "none") return { kind: "anonymous" };
  return lookup.user.isInstanceAdmin
    ? { kind: "admin", user: lookup.user }
    : { kind: "not_admin" };
}
