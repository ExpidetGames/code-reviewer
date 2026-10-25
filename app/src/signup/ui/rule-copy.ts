// SPDX-License-Identifier: LicenseRef-Proprietary

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
    text: "Anyone who can reach this server can create an account.",
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
 * The warning while a rule that names emails or domains cannot verify anyone (ADR section 2.5),
 * including the remedy: a mail server or GitHub as the only way to sign in makes the rule work. The
 * wizard shows this in the InfoHint next to the entry field and keeps a one-line summary
 * (`FAIL_CLOSED_LINE`) beside it (#172); the portal points at its Mail and Setup pages and adds what
 * the rule means for invitations. Both import this.
 */
export const FAIL_CLOSED_WARNING =
  "Rules that name emails or domains need verified addresses, and nothing can verify them right now. Until then nobody except you can sign up. A mail server or GitHub as the only way to sign in makes the rule work.";
