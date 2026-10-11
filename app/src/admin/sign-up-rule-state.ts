// SPDX-License-Identifier: Apache-2.0

// Whether the sign-up rule works right now (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5). A rule that names emails or domains is only meaningful for verified addresses, and an
// address can be verified through a mail server or through GitHub. It is fail-closed (nobody except
// the instance admin can sign up, and no invitation can be created) while neither path exists: no mail
// server and sign-in is not GitHub only. The state is worked out when it is asked for, never stored,
// so removing the mail server turns the rule fail-closed again.
//
// The portal uses this for its notice (overview and setup page). The sign-up itself comes with the
// sign-up rules issue, which reads the same function.
import type { InstanceSettingValues } from "../db/repositories/instance-settings-repository.ts";
import type { SignInMethods } from "./sign-in-methods.ts";

export type SignUpRuleState = { failClosed: boolean };

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
  const githubOnly = signInMethods.github && !signInMethods.emailPassword;
  return { failClosed: !mailConfigured && !githubOnly };
}
