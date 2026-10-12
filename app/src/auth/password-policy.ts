// SPDX-License-Identifier: Apache-2.0

// The password rule of every email and password account (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.2): at least 12 and at most 128 characters, and not a common password. No
// composition rules ("one digit, one symbol"): length and an unguessable choice are what protect an
// account, and a rule about character classes makes people write `Password1!`. The server checks it
// wherever a password is set; the form shows the reason. Characters are counted as Unicode code
// points, so twelve letters of any script are twelve characters; the upper bound must hold for the
// UTF-16 length too, which is how Better Auth counts it.
import { COMMON_BASES, COMMON_PASSWORDS } from "./common-passwords.ts";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_ERROR_CODES = [
  "password_too_short",
  "password_too_long",
  "password_too_common",
] as const;
export type PasswordErrorCode = (typeof PASSWORD_ERROR_CODES)[number];

/**
 * The rule under every password field, in one sentence, and the same words wherever the rule is stated
 * (#169). The length numbers are written out so the copy reads as one sentence; the copy-ownership test
 * (`app/src/copy/ownership.test.ts`) checks them against the constants above.
 */
export const PASSWORD_RULE_HINT =
  "At least 12 and at most 128 characters, and not a common password.";

/** The two fields of a password form do not hold the same password. */
export const PASSWORDS_DO_NOT_MATCH = "The two passwords are not the same.";

export type PasswordCheck =
  { ok: true } | { ok: false; code: PasswordErrorCode };

/** What the form says for each refusal; the codes are the contract, the sentences are copy. */
export const PASSWORD_ERROR_COPY: Record<PasswordErrorCode, string> = {
  password_too_short: `Use at least ${String(PASSWORD_MIN_LENGTH)} characters. A long password is the strongest protection of an account.`,
  password_too_long: `Use at most ${String(PASSWORD_MAX_LENGTH)} characters.`,
  password_too_common:
    "This password is too common and would be guessed quickly. Choose something longer or less usual, for example a few unrelated words.",
};

const PADDING = /[0-9!@#$%^&*()_+=.,?-]+$/;

/** Lower case, compatibility normalized (full-width letters become plain ones). */
function normalized(password: string): string {
  return password.normalize("NFKC").toLowerCase();
}

function isCommonPassword(password: string): boolean {
  const candidate = normalized(password);
  if (COMMON_PASSWORDS.has(candidate)) return true;
  // One character repeated.
  if (new Set(Array.from(candidate)).size === 1) return true;
  // A well-known word with nothing but digits and symbols behind it.
  const base = candidate.replace(PADDING, "");
  return base !== candidate && COMMON_BASES.has(base);
}

export function checkPassword(password: string): PasswordCheck {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH)
    return { ok: false, code: "password_too_short" };
  // Better Auth counts UTF-16 units (`password.length`) when it checks a password on sign in. A
  // password of astral characters (emoji, some scripts) is longer by that count than by ours, and
  // one that passes only ours could be set but never used to sign in. Both counts must be in range.
  if (length > PASSWORD_MAX_LENGTH || password.length > PASSWORD_MAX_LENGTH)
    return { ok: false, code: "password_too_long" };
  if (isCommonPassword(password))
    return { ok: false, code: "password_too_common" };
  return { ok: true };
}
