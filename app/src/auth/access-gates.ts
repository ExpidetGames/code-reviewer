// SPDX-License-Identifier: Apache-2.0

// The two conditions, besides a valid session, that an email and password account has to meet before it
// can use the app (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.5 and 2.6). Both are
// asked on every request, never remembered, so a mail server that is added or removed, or an invitation
// that is accepted, takes effect at once.
//
// - Its email address is verified, while the instance can verify addresses (a mail server is configured).
//   Without a mail server nothing can be verified and accounts are usable unverified. The instance admin
//   keeps `/admin` meanwhile, so a problem with the mail server can always be repaired.
// - It belongs to a workspace. An account made by the sign-up has none and no access to any customer
//   data: in a single-tenant instance the person asks an admin for an invitation, and nothing joins them
//   automatically; in a multi-tenant instance they accept an invitation or create a workspace (the
//   page behind `/no-access`, src/workspaces/README.md). The instance admin is exempt, so that the
//   portal is always reachable. Every identity is asked this, the GitHub ones too.
//
// Accounts that sign in with GitHub are asked the workspace question only: their admission is the GitHub
// allow list (access-policy.ts) until the GitHub issues replace it, and their address is not verified by
// the app.
import type { WorkspaceRole } from "../workspaces/roles.ts";

export type AccessGates = {
  /** Whether email and password accounts must have a verified address: the instance can send mail. */
  verificationRequired(): Promise<boolean>;
  /** Whether the user is a member of at least one workspace. */
  hasWorkspace(userId: string): Promise<boolean>;
  /**
   * The role the user has in the workspace with this slug, or null when there is no such workspace or
   * they do not belong to it (the two are not told apart). Asked by the proxy for every request to a
   * workspace address.
   */
  workspaceRole(userId: string, slug: string): Promise<WorkspaceRole | null>;
};
