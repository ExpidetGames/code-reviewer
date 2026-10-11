// SPDX-License-Identifier: Apache-2.0

// Whether the sign-up rule works right now (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5). A rule that names emails or domains is only meaningful for verified addresses, and an
// address can be verified through a mail server or through GitHub. It is fail-closed (nobody except
// the instance admin can sign up, and no invitation can be created) while neither path exists: no mail
// server and sign-in is not GitHub only. The state is worked out when it is asked for, never stored,
// so removing the mail server turns the rule fail-closed again.
//
// The portal uses this for its notice (overview and setup page), and the sign-up reads the same
// function (src/signup/availability.ts), so the notice and the behavior cannot disagree.
import type { InstanceSettingValues } from "../db/repositories/instance-settings-repository.ts";
import type { SignInMethods } from "./sign-in-methods.ts";

export type SignUpRuleState = { failClosed: boolean };

/**
 * Whether the instance can verify an email address at all: through a mail server (the app sends a link),
 * or because GitHub is the only way to sign in (GitHub reports the verified primary email). Evaluated
 * when it matters, never stored.
 */
export function verificationPathExists({
  mailConfigured,
  signInMethods,
}: {
  mailConfigured: boolean;
  /** What is actually on (`effectiveSignInMethods`). */
  signInMethods: SignInMethods;
}): boolean {
  const githubOnly = signInMethods.github && !signInMethods.emailPassword;
  return mailConfigured || githubOnly;
}

export function signUpRuleState({
  rule,
  mailConfigured,
  signInMethods,
}: {
  rule: InstanceSettingValues["sign_up_rule"];
  mailConfigured: boolean;
  /** What is actually on (`effectiveSignInMethods`). */
  signInMethods: SignInMethods;
}): SignUpRuleState {
  if (rule.kind === "everyone") return { failClosed: false };
  return {
    failClosed: !verificationPathExists({ mailConfigured, signInMethods }),
  };
}
