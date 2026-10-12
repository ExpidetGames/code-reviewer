// SPDX-License-Identifier: Apache-2.0

// What a sign in with GitHub does with the person (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.5 and 2.6), as a decision made before anything is written. The inputs are what GitHub said
// (the numeric account id and the list of email addresses) and what the instance knows (who owns that
// GitHub id, who has that verified address, the sign-up rule). The answer is who the person is for Better
// Auth, or a refusal with a stable code that the login page translates.
//
// - A GitHub identity that is linked to a user signs in as that user, whatever the sign-up rule says: the
//   rule is about creating accounts. An imported user's placeholder address is replaced by GitHub's verified
//   primary address when nobody else has it; when another account has it, the placeholder stays, nothing is
//   taken over or merged, and the conflict is recorded so that the profile and the admin can show a hint.
// - A GitHub identity that is new needs a verified primary address. If an account has that address it is
//   linked to it only when that account's address is verified too (never on an unverified match); an account
//   that already has another GitHub identity is never given a second one. If no account has it, a new
//   account is made when the sign-up rule lets the address in.
// - Accounts are never linked by an address alone: the address must be GitHub's verified primary one, the
//   account's own must be verified, and the identity must not belong to anybody else.
import {
  decideGithubLink,
  decideGithubSignUp,
  verifiedPrimaryEmail,
  type GithubEmail,
  type GithubSignUpErrorCode,
} from "../signup/github.ts";
import type { SignUpRule } from "../signup/rule.ts";

export const GITHUB_SIGN_IN_REFUSALS = [
  /** The rule names emails or domains and nothing can verify an address: fail-closed. */
  "signup_closed",
  /** GitHub reports no verified primary email. */
  "github_email_unverified",
  /** The verified email is not one the sign-up rule lets in. */
  "email_not_allowed",
  /** An account has this address and one of the two sides is not verified: nothing is linked. */
  "email_exists_unverified",
  /** The account with this address has another GitHub identity already. */
  "github_identity_conflict",
  /** The email addresses could not be read (the App lacks the permission, or GitHub failed). */
  "check_failed",
] as const;
export type GithubSignInRefusal = (typeof GITHUB_SIGN_IN_REFUSALS)[number];

export function isGithubSignInRefusal(
  value: unknown,
): value is GithubSignInRefusal {
  return (GITHUB_SIGN_IN_REFUSALS as readonly unknown[]).includes(value);
}

/** The address GitHub's old sign in stored for a user: `<github id>@users.noreply.github.com`. */
const PLACEHOLDER_DOMAIN = "@users.noreply.github.com";

export function isPlaceholderEmail(email: string): boolean {
  return email.toLowerCase().endsWith(PLACEHOLDER_DOMAIN);
}

/** A user as the sign in needs to know them. */
export type KnownUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  /** When the user was imported from an installation that existed before accounts, or null. */
  importedAt: string | null;
  /** The numeric GitHub id of the identity linked to the user, or null. */
  githubId: string | null;
};

export type IdentityDirectory = {
  /** The user the GitHub account with this numeric id is linked to. */
  findByGithubId(githubId: string): Promise<KnownUser | null>;
  /** The user with this (canonical) email address. */
  findByEmail(email: string): Promise<KnownUser | null>;
};

export type GithubSignInOutcome =
  /** A linked identity signs in as its user. */
  | "existing"
  /** The same, and the placeholder address was replaced by GitHub's verified primary one. */
  | "replaced_placeholder"
  /** The same, and the placeholder stays because another account has GitHub's address. */
  | "kept_placeholder"
  /** A new identity is linked to the account that has its verified address. */
  | "link"
  /** A new account is made. */
  | "create";

export type GithubSignInDecision =
  | {
      allowed: true;
      outcome: GithubSignInOutcome;
      /** The address of the user after this sign in. */
      email: string;
      emailVerified: boolean;
      /**
       * The GitHub address another account already has, for a placeholder that could not be replaced; null
       * when there is no such conflict (it is cleared by a sign in that finds none).
       */
      emailConflict: string | null;
    }
  | { allowed: false; reason: GithubSignInRefusal };

export type DecideGithubSignInInput = {
  /** The numeric GitHub id of the account, as text. */
  githubId: string;
  /** What `GET /user/emails` said; null when it could not be read. */
  emails: readonly GithubEmail[] | null;
  directory: IdentityDirectory;
  rule: SignUpRule;
  /** `signUpRuleState(...).failClosed` for the rule. */
  failClosed: boolean;
};

function refuse(reason: GithubSignInRefusal): GithubSignInDecision {
  return { allowed: false, reason };
}

function refusalOf(code: GithubSignUpErrorCode): GithubSignInRefusal {
  return code;
}

export async function decideGithubSignIn({
  githubId,
  emails,
  directory,
  rule,
  failClosed,
}: DecideGithubSignInInput): Promise<GithubSignInDecision> {
  const primary = emails === null ? null : verifiedPrimaryEmail(emails);

  const owner = await directory.findByGithubId(githubId);
  if (owner !== null) {
    const keep: GithubSignInDecision = {
      allowed: true,
      outcome: "existing",
      email: owner.email,
      emailVerified: owner.emailVerified,
      emailConflict: null,
    };
    // Only an imported user has a placeholder to replace; the address of anybody else stays as it is.
    if (owner.importedAt === null || !isPlaceholderEmail(owner.email))
      return keep;
    // Nothing to replace it with (the addresses could not be read, or none is verified): the sign in does
    // not depend on it.
    if (primary === null) return keep;
    const holder = await directory.findByEmail(primary);
    if (holder === null || holder.id === owner.id)
      return {
        allowed: true,
        outcome: "replaced_placeholder",
        email: primary,
        emailVerified: true,
        emailConflict: null,
      };
    return {
      allowed: true,
      outcome: "kept_placeholder",
      email: owner.email,
      emailVerified: owner.emailVerified,
      emailConflict: primary,
    };
  }

  // A new identity.
  if (emails === null) return refuse("check_failed");
  const existing =
    primary === null ? null : await directory.findByEmail(primary);
  const link = decideGithubLink(existing);
  if (link.action === "refuse") return refuse(link.error);
  if (link.action === "link" && existing !== null) {
    // One GitHub identity per account: a second would make the account reachable from two GitHub accounts.
    if (existing.githubId !== null) return refuse("github_identity_conflict");
    return {
      allowed: true,
      outcome: "link",
      email: existing.email,
      emailVerified: true,
      emailConflict: null,
    };
  }
  const signUp = decideGithubSignUp({
    rule,
    failClosed,
    primaryEmail: primary,
  });
  if (!signUp.ok) return refuse(refusalOf(signUp.error));
  return {
    allowed: true,
    outcome: "create",
    email: signUp.email,
    emailVerified: true,
    emailConflict: null,
  };
}
