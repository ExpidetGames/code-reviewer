// SPDX-License-Identifier: Apache-2.0

// The copy for the error codes of the workspace routes (the UI translates a code to copy, never the other
// way round).
import {
  CROSS_SITE_REQUEST,
  INVALID_EMAIL,
  NOT_AVAILABLE_TO_YOU,
  ROLE_NOT_ALLOWED,
  TOO_MANY_ATTEMPTS,
} from "../../copy/messages.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

/** The one owner of the lifetime of an invitation link (#169). */
export const INVITATION_LINK_LIFETIME =
  "An invitation works once, for 7 days, for the address it was made for.";

const FAILURE_COPY: Record<string, string> = {
  forbidden: ROLE_NOT_ALLOWED,
  not_found: NOT_AVAILABLE_TO_YOU,
  member_not_found: "That person is not a member of this workspace.",
  last_owner: "A workspace needs an Owner. Make somebody else an Owner first.",
  invalid_role: "That is not a role.",
  invalid_name: "Use 1 to 80 characters, without line breaks.",
  invalid_email: INVALID_EMAIL,
  invalid_request:
    "The request was not complete. Reload the page and try again.",
  email_not_allowed:
    "The sign-up rule of this instance does not let that address in, so it can neither be invited nor accept an invitation. An admin of the instance can change the rule.",
  signup_closed:
    "Invitations are closed on this instance right now: the sign-up rule names addresses, and nothing can verify them yet. Ask the person who runs the instance.",
  already_member: "That address belongs to a member of this workspace already.",
  already_invited:
    "That address has an invitation already. Revoke it first, or send it again.",
  not_available:
    "This instance cannot send mail, so a link cannot be sent again. Revoke the invitation and invite the address once more to get a new link.",
  rate_limited: TOO_MANY_ATTEMPTS,
  multi_tenant_required:
    "This instance has one workspace and people cannot create more.",
  workspace_limit_reached:
    "You own as many workspaces as this instance allows.",
  invitation_not_found: "This invitation does not exist.",
  invitation_expired: "This invitation has expired. Ask for a new one.",
  invitation_revoked: "This invitation was withdrawn.",
  invitation_used: "This invitation was used already.",
  email_mismatch:
    "You are signed in with another address than the one this invitation is for.",
  email_not_verified:
    "Confirm your email address first, then accept the invitation.",
  cross_site_request: CROSS_SITE_REQUEST,
  name_mismatch: "That is not the name of this workspace.",
  balance_positive:
    "This workspace still has unused credit, so it cannot be deleted yet. Contact support and we will sort the credit out with you first.",
  review_running:
    "A review is running right now. Try again when it has finished.",
  payment_open:
    "A payment is still open. Try again once it has gone through or has expired.",
};

/** The words of the Advanced page: the one action it has. */
export const DELETE_WORKSPACE_COPY = {
  title: "Delete workspace",
  description:
    "Removes this workspace with its projects, runs, settings and keys, and disconnects its GitHub installations. This cannot be undone.",
  action: "Delete workspace…",
  confirmTitle: (name: string) => `Delete ${name}?`,
  confirmDescription:
    "Everyone loses access, pending reviews are cancelled and the GitHub installations are released. Billing records are kept for the books.",
  nameLabel: (name: string) => `Type ${name} to confirm`,
  confirm: "Delete this workspace",
  deleting: "Deleting",
} as const;

/** The sentence for a failed call of a workspace route. */
export function describeWorkspaceFailure(code: string): string {
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

/** The sentence for the state of an invitation link on its page. */
export function describeInvitationState(code: string): string {
  return describeWorkspaceFailure(
    ["invitation_expired", "invitation_revoked", "invitation_used"].includes(
      code,
    )
      ? code
      : "invitation_not_found",
  );
}
