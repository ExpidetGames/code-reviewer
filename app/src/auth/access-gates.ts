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
//   automatically. (The workspaces issue replaces this check with the workspace pages; it is the
//   interim guard that keeps a new account away from the data until then.) The instance admin is exempt.
//
// An account that signs in with GitHub only is asked the second question only: the address GitHub reports as
// the verified primary one was verified at the sign in (an imported user's placeholder waits for it). Who may
// have an account at all was decided when it was made, by the sign-up rule (src/github-signin/decide.ts).
export type AccessGates = {
  /** Whether email and password accounts must have a verified address: the instance can send mail. */
  verificationRequired(): Promise<boolean>;
  /** Whether the user is a member of at least one workspace. */
  hasWorkspace(userId: string): Promise<boolean>;
};
