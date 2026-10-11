// SPDX-License-Identifier: Apache-2.0

// The copy for the error codes of the workspace routes (the UI translates a code to copy, never the other
// way round).
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const FAILURE_COPY: Record<string, string> = {
  forbidden: "Your role in this workspace does not allow that.",
  not_found: "That is not available to you.",
  member_not_found: "That person is not a member of this workspace.",
  last_owner: "A workspace needs an Owner. Make somebody else an Owner first.",
  invalid_role: "That is not a role.",
  invalid_name: "Use 1 to 80 characters, without line breaks.",
  invalid_email: "Enter a valid email address.",
  invalid_request:
    "The request was not complete. Reload the page and try again.",
  email_not_allowed:
    "The sign-up rule of this instance does not let that address in, so it cannot be invited. An admin of the instance can change the rule.",
  signup_closed:
    "Invitations are closed on this instance right now: the sign-up rule names addresses, and nothing can verify them yet. Ask the person who runs it.",
  already_member: "That address belongs to a member of this workspace already.",
  already_invited:
    "That address has an invitation already. Revoke it first, or send it again.",
  not_available:
    "This instance cannot send mail, so a link cannot be sent again. Revoke the invitation and invite the address once more to get a new link.",
  rate_limited: "Too many attempts. Wait a while and try again.",
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
  cross_site_request: "The request did not come from this page. Reload it.",
};

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
