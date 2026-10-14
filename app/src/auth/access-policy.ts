// SPDX-License-Identifier: Apache-2.0

// The signed in user as the pages and the route handlers see them. Who may use the instance is decided
// when the account is made (the first-run setup, the sign-up rule, an invitation) and by the two gates in
// front of the app (src/auth/access-gates.ts, src/auth/session-user.ts). No request is judged by the allow
// list of the earlier sign in any more (its code was removed with #159).

/** The part of the signed in user that a page or a route may look at. */
export type SessionUser = {
  id: string;
  name: string;
  email: string;
  /** The instance admin flag (the account the first-run setup created). */
  isInstanceAdmin: boolean;
  /** The current GitHub login (refreshed at every sign in), or null for an account without GitHub. */
  githubLogin: string | null;
  /** The stable numeric GitHub id of the account (from its `accounts` row), as text, or null. */
  githubId: string | null;
  /** The avatar address from the GitHub profile (refreshed at every sign in), if there is one. For display only. */
  image?: string | null;
};

/** The name to show for a user, and to record as the actor of an action: the GitHub login, or the email. */
export function actorName(
  user: Pick<SessionUser, "githubLogin" | "email">,
): string {
  return user.githubLogin ?? user.email;
}
