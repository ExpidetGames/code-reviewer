// SPDX-License-Identifier: Apache-2.0

// The sign-up rule as pure logic (docs/decisions/0001-editions-setup-and-accounts.md, section 2.5):
// which email addresses a rule lets in. There are exactly three rules, `everyone`, a list of emails
// and a list of domains. Matching ignores case and surrounding white space, a domain entry matches
// exactly that domain (never a subdomain), a plus tag is not stripped, an internationalized domain is
// compared in its punycode form, and an empty list lets nobody in.
//
// The sign-up, the invitations (a later issue) and the GitHub sign-in all ask this one function, with
// the address the rule is to be applied to: for an email and password sign-up the address that was
// typed (the account is created unverified and the rule says whether it may be), for GitHub the
// verified primary email that GitHub reports. Whether the instance can verify addresses at all is a
// different question (`src/admin/sign-up-rule-state.ts`).
import { domainToASCII } from "node:url";
import type { InstanceSettingValues } from "../db/repositories/instance-settings-repository.ts";
import { isValidEmail } from "../setup/input.ts";

export type SignUpRule = InstanceSettingValues["sign_up_rule"];

/**
 * What nothing saved reads as: a rule that lets nobody in (an empty list). The admin portal shows the
 * same, so the page and the behavior agree.
 */
export const CLOSED_RULE: SignUpRule = { kind: "emails", entries: [] };

export const SIGN_UP_RULE_ERROR_CODES = [
  /** The text is not a well-formed email address. */
  "invalid_email",
  /** The address is well-formed, and the rule does not let it in. */
  "email_not_allowed",
] as const;
export type SignUpRuleErrorCode = (typeof SIGN_UP_RULE_ERROR_CODES)[number];

/**
 * Domains no sign-up can use, whatever the rule says. A GitHub user carries `<github id>@users.noreply.
 * github.com` as a placeholder address (src/auth/github-provider.ts) and the column is unique, so an
 * account made for such an address by someone else would keep the real GitHub user from ever signing in.
 */
export const RESERVED_EMAIL_DOMAINS: readonly string[] = [
  "users.noreply.github.com",
];

export type RuleVerdict =
  /** `email` is the address in its canonical form: trimmed, lower case, the domain in punycode. */
  { ok: true; email: string } | { ok: false; error: SignUpRuleErrorCode };

/**
 * The address as the app stores and compares it, or null when it is not a well-formed address. The
 * rule of "well-formed" is the one Better Auth applies at every sign in (`isValidEmail`): an address
 * the sign-up accepted but the sign in rejected would be an account nobody can use.
 */
export function canonicalEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) return null;
  const local = text.slice(0, at).toLowerCase();
  const domain = domainToASCII(text.slice(at + 1).toLowerCase());
  // `domainToASCII` answers "" for a name it cannot convert.
  if (domain === "") return null;
  const candidate = `${local}@${domain}`;
  return isValidEmail(candidate) ? candidate : null;
}

/** Whether `rule` lets this address in. */
export function evaluateSignUpRule(
  rule: SignUpRule,
  raw: unknown,
): RuleVerdict {
  const email = canonicalEmail(raw);
  if (email === null) return { ok: false, error: "invalid_email" };
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (RESERVED_EMAIL_DOMAINS.includes(domain))
    return { ok: false, error: "email_not_allowed" };
  const wanted = rule.kind === "domains" ? domain : email;
  // The entries are stored lower case; comparing lower case here makes a hand-edited row safe too.
  const allowed =
    rule.kind === "everyone" ||
    rule.entries.some((entry) => entry.toLowerCase() === wanted);
  return allowed
    ? { ok: true, email }
    : { ok: false, error: "email_not_allowed" };
}
