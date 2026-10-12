// SPDX-License-Identifier: Apache-2.0

// The copy of the sign-up rule, shared by the first-run wizard and the admin forms (#169). The wizard
// and the portal asked the same question with different words; the words live here once.

export type SignUpRuleKind = "everyone" | "emails" | "domains";

/** The three answers, in the order they are offered, with the sentence under each title. */
export const SIGN_UP_RULE_OPTIONS: ReadonlyArray<{
  value: SignUpRuleKind;
  title: string;
  text: string;
}> = [
  {
    value: "everyone",
    title: "Everyone",
    text: "Anyone who can reach this instance can create an account.",
  },
  {
    value: "emails",
    title: "A list of email addresses",
    text: "Only the addresses you list can create an account.",
  },
  {
    value: "domains",
    title: "Allowed email domains",
    text: "Anyone with an address at one of the domains you list (not its subdomains) can create an account.",
  },
];

/**
 * The core of the warning while a rule that names emails or domains cannot verify anyone (ADR section
 * 2.5). The wizard and the portal add their own next sentence: there are no invitations during the
 * setup, and there is no admin area before it.
 */
export const FAIL_CLOSED_WARNING =
  "Rules that name emails or domains need verified addresses, and nothing can verify them right now. Until then nobody except you can sign up.";
