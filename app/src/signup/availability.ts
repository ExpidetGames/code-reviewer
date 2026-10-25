// SPDX-License-Identifier: LicenseRef-Proprietary

// Whether an email and password sign-up is open right now (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.5). It depends on the instance, not on the address: email with password has to
// be one of the ways to sign in, and a rule that names emails or domains stays closed while no
// verification path exists (`signUpRuleState`, the very function that drives the admin portal's notice).
// The state is worked out per request and never stored, so removing the mail server closes such a rule
// again at once. The instance admin needs no sign-up: the account exists.
import type { SignInMethods } from "../admin/sign-in-methods.ts";
import { signUpRuleState } from "../admin/sign-up-rule-state.ts";
import type { SignUpRule } from "./rule.ts";

export const SIGN_UP_UNAVAILABLE_CODES = [
  /** The rule names emails or domains and nothing can verify an address yet. */
  "signup_closed",
  /** Email with password is switched off. */
  "sign_up_disabled",
] as const;
export type SignUpUnavailableCode = (typeof SIGN_UP_UNAVAILABLE_CODES)[number];

export type SignUpAvailability =
  /** `verifyByMail`: a new account must verify its address through a mail the app sends. */
  | { open: true; verifyByMail: boolean }
  | { open: false; error: SignUpUnavailableCode };

export function signUpAvailability({
  rule,
  mailConfigured,
  signInMethods,
}: {
  rule: SignUpRule;
  mailConfigured: boolean;
  /** What is actually on (`effectiveSignInMethods`). */
  signInMethods: SignInMethods;
}): SignUpAvailability {
  if (!signInMethods.emailPassword)
    return { open: false, error: "sign_up_disabled" };
  if (signUpRuleState({ rule, mailConfigured, signInMethods }).failClosed)
    return { open: false, error: "signup_closed" };
  return { open: true, verifyByMail: mailConfigured };
}
