// SPDX-License-Identifier: Apache-2.0

// What the sign-up rules say about a GitHub sign-in (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5), as pure logic for the issue that moves the sign-in to the GitHub App: the rule is applied
// to the verified primary email that GitHub reports, and an unverified or missing email means refused; a
// GitHub identity is linked to an existing email account only when GitHub reports the same verified email
// and the account's email is verified too (an unverified match never links, so nobody takes over an
// account through an address they only claimed).
//
// The sign-in that exists today (the GitHub OAuth app and its allow list, src/auth/) does not read the
// email and stays as it is until the import issue; nothing calls these functions yet.
import { canonicalEmail, evaluateSignUpRule, type SignUpRule } from "./rule.ts";

/** An entry of GitHub's `GET /user/emails`. */
export type GithubEmail = {
  email: string;
  primary: boolean;
  verified: boolean;
};

/** The primary email address of the account when GitHub says it is verified; otherwise null. */
export function verifiedPrimaryEmail(
  emails: readonly GithubEmail[],
): string | null {
  const primary = emails.find((entry) => entry.primary);
  if (primary === undefined || !primary.verified) return null;
  return canonicalEmail(primary.email);
}

export const GITHUB_SIGN_UP_ERROR_CODES = [
  /** The rule names emails or domains and nothing can verify an address (docs section 2.5): fail-closed. */
  "signup_closed",
  /** GitHub reports no verified primary email. */
  "github_email_unverified",
  /** The verified email is not one the rule lets in. */
  "email_not_allowed",
] as const;
export type GithubSignUpErrorCode = (typeof GITHUB_SIGN_UP_ERROR_CODES)[number];

export type GithubSignUpDecision =
  { ok: true; email: string } | { ok: false; error: GithubSignUpErrorCode };

/** Whether a new GitHub account may be created. `primaryEmail` is `verifiedPrimaryEmail(...)`. */
export function decideGithubSignUp({
  rule,
  failClosed,
  primaryEmail,
}: {
  rule: SignUpRule;
  /** `signUpRuleState(...).failClosed` for the rule. */
  failClosed: boolean;
  primaryEmail: string | null;
}): GithubSignUpDecision {
  if (failClosed) return { ok: false, error: "signup_closed" };
  if (primaryEmail === null)
    return { ok: false, error: "github_email_unverified" };
  const verdict = evaluateSignUpRule(rule, primaryEmail);
  return verdict.ok
    ? { ok: true, email: verdict.email }
    : { ok: false, error: "email_not_allowed" };
}

export type GithubLinkDecision =
  /** No account has this address: a new account is made (when the sign-up rule lets it). */
  | { action: "create" }
  /** The account with this address is the one this GitHub identity is linked to. */
  | { action: "link" }
  /** An account has the address, but one of the two sides is not verified: nothing is linked. */
  | { action: "refuse"; error: "email_exists_unverified" };

/**
 * What to do with a GitHub identity whose verified primary email is the address of `existing`, given the
 * account that has this address (null when no account has it).
 */
export function decideGithubLink(
  existing: {
    emailVerified: boolean;
  } | null,
): GithubLinkDecision {
  if (existing === null) return { action: "create" };
  return existing.emailVerified
    ? { action: "link" }
    : { action: "refuse", error: "email_exists_unverified" };
}
