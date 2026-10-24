// SPDX-License-Identifier: LicenseRef-Proprietary

// Carrying an invitation link through the sign-in and the sign-up. A person who opens an invitation link
// without a session is sent to `/login?invitation=<token>` or `/sign-up?invitation=<token>`; after the
// sign-in they land on the page of the invitation again (src/app/invitation) to accept it. Only a value
// shaped like a link token is ever carried, and the only place it leads to is that page, so the parameter
// can not be used to send a person anywhere else.
import { isWellFormedLinkToken } from "../admin-cli/token.ts";

/** The path of the invitation page for a token, or null when the value is not a token. */
export function invitationReturnPath(token: unknown): string | null {
  return isWellFormedLinkToken(token)
    ? `/invitation?token=${encodeURIComponent(token)}`
    : null;
}

/** The token if the value is one, else null: what the login and sign-up pages put into their forms. */
export function invitationTokenOf(value: unknown): string | null {
  return isWellFormedLinkToken(value) ? value : null;
}

/** `/login` or `/sign-up` with the invitation carried along (when there is one). */
export function pathCarrying(
  path: "/login" | "/sign-up",
  token: unknown,
  extra: Record<string, string> = {},
): string {
  const query = new URLSearchParams(extra);
  const carried = invitationTokenOf(token);
  if (carried !== null) query.set("invitation", carried);
  const text = query.toString();
  return text === "" ? path : `${path}?${text}`;
}

/**
 * Where a person goes right after signing in. The invitation page when they came from one, unless they
 * still have to confirm their address (that page is the only one they can use then).
 */
export function landingWithInvitation(landing: string, token: unknown): string {
  const invitation = invitationReturnPath(token);
  if (invitation === null || landing === "/verify-email") return landing;
  return invitation;
}
