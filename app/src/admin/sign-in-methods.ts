// SPDX-License-Identifier: Apache-2.0

// The ways to sign in (docs/decisions/0001-editions-setup-and-accounts.md, section 2.3): email with
// password and GitHub can each be switched off, but at least one stays on. GitHub can only be on while
// the GitHub integration is configured. Switching to GitHub only is refused unless the acting admin has
// a linked GitHub identity, so the admin cannot lock themselves out. Pure rules; the service reads the
// facts they need.
import type { InstanceSettingValues } from "../db/repositories/instance-settings-repository.ts";

export type SignInMethods = InstanceSettingValues["sign_in_methods"];

export const SIGN_IN_METHODS_ERROR_CODES = [
  /** Both ways would be off. */
  "at_least_one_method",
  /** GitHub would be on, and the GitHub integration is not configured. */
  "github_not_configured",
  /** GitHub only, and the acting admin has no linked GitHub identity that would sign in afterwards. */
  "admin_needs_github_identity",
] as const;
export type SignInMethodsErrorCode =
  (typeof SIGN_IN_METHODS_ERROR_CODES)[number];

/**
 * What is actually on. Nothing saved: email with password, and GitHub where it is configured.
 * GitHub that is switched on but not configured offers nothing. If that would leave no way in at all
 * (a saved GitHub only, whose configuration is gone), email with password stays on, so a mistake
 * elsewhere can never lock everybody out.
 */
export function effectiveSignInMethods(
  stored: SignInMethods | undefined,
  githubConfigured: boolean,
): SignInMethods {
  if (stored === undefined)
    return { emailPassword: true, github: githubConfigured };
  const github = stored.github && githubConfigured;
  return { emailPassword: stored.emailPassword || !github, github };
}

export type SignInMethodsFacts = {
  githubConfigured: boolean;
  /**
   * Whether the admin who makes the change has a GitHub identity linked to their account that the
   * access policy lets through today (github-identity.ts): one that would sign in.
   */
  actorHasGithubIdentity: boolean;
};

export function checkSignInMethods(
  wanted: SignInMethods,
  facts: SignInMethodsFacts,
): { ok: true } | { ok: false; error: SignInMethodsErrorCode } {
  if (wanted.github && !facts.githubConfigured)
    return { ok: false, error: "github_not_configured" };
  if (!wanted.emailPassword && !wanted.github)
    return { ok: false, error: "at_least_one_method" };
  if (!wanted.emailPassword && !facts.actorHasGithubIdentity)
    return { ok: false, error: "admin_needs_github_identity" };
  return { ok: true };
}
