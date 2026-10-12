// SPDX-License-Identifier: Apache-2.0

// The vocabulary of a request to link an installation that the instance admin decides (docs/decisions/0001-
// editions-setup-and-accounts.md, section 2.9). Pure types and lists, shared by the tables, the services and the
// pages.

export const LINK_REQUEST_STATUSES = [
  "pending",
  "approved",
  "denied",
  /** Linked in the meantime by the ordinary way (the role could be read this time). */
  "withdrawn",
] as const;
export type InstallationLinkRequestStatus =
  (typeof LINK_REQUEST_STATUSES)[number];

/**
 * The result of reading the requester's role in the installation's account:
 * - `admin`: the personal account itself, or an owner of the organization;
 * - `member`: a member of the organization who is not an owner;
 * - `not_a_member`: GitHub says the person does not belong to the organization;
 * - `unreadable`: GitHub refused the read (the App lacks the permission "Members", or the token may not);
 * - `unavailable`: the role was not asked (the user authorization of the App is not configured).
 */
export const ROLE_RESULTS = [
  "admin",
  "member",
  "not_a_member",
  "unreadable",
  "unavailable",
] as const;
export type RoleResult = (typeof ROLE_RESULTS)[number];

export function isRoleResult(value: unknown): value is RoleResult {
  return ROLE_RESULTS.some((result) => result === value);
}

/** What the approval page shows about the requester's own access, never the token. */
export type LinkEvidence = {
  /** Whether the requester's token lists the installation; null when it could not be asked. */
  tokenCanAccess: boolean | null;
  roleResult: RoleResult;
  /** A stable code that says why the role could not be read, or null. */
  roleDetail: string | null;
};

export type InstallationLinkRequest = {
  id: string;
  workspaceId: string;
  /** The user who asked; null once the user is gone. */
  requestedBy: string | null;
  /** The GitHub account the requester proved control of. */
  requesterGithubLogin: string | null;
  installationId: string;
  accountLogin: string;
  /** `User` or `Organization`. */
  accountType: string;
  accountId: string;
  status: InstallationLinkRequestStatus;
  evidence: LinkEvidence;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
};

export type NewInstallationLinkRequest = {
  requestedBy: string;
  requesterGithubLogin: string | null;
  installationId: string;
  accountLogin: string;
  accountType: string;
  accountId: string;
  evidence: LinkEvidence;
};

/** A request with the names the instance admin needs to decide it. */
export type InstallationLinkRequestView = InstallationLinkRequest & {
  workspaceName: string;
  workspaceSlug: string;
  /** The requester's display name and address, when the user still exists. */
  requesterName: string | null;
  requesterEmail: string | null;
};
