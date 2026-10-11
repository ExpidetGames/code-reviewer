// Translates the `error` code in the login page URL to copy. The code comes from Better Auth (or
// from GitHub, for access_denied) and is untrusted: it only selects a message, it is never shown.

const MESSAGES: Readonly<Record<string, string>> = {
  access_denied:
    "You cancelled the sign in at GitHub. Sign in again if you want to use Code Reviewer.",
  state_mismatch:
    "The sign in could not be matched to its start. Please start again.",
  state_not_found:
    "The sign in could not be matched to its start. Please start again.",
  please_restart_the_process:
    "The sign in could not be matched to its start. Please start again.",
  invalid_code: "GitHub did not complete the sign in. Please try again.",
  no_code: "GitHub did not complete the sign in. Please try again.",
  unable_to_get_user_info:
    "Could not read your GitHub profile. Please try again.",
  email_not_found: "Could not read your GitHub profile. Please try again.",
  // The allow list (CR-19). Deliberately says nothing about who is allowed.
  not_allowed:
    "Your GitHub account is not allowed to use this Code Reviewer instance.",
  check_failed:
    "We could not check whether your GitHub account is allowed to use this Code Reviewer instance. Please try again later.",
  sign_in_again:
    "Your GitHub authorization is no longer valid. Please sign in again.",
  // Email and password.
  invalid_credentials: "The email address or the password is not correct.",
  rate_limited: "Too many sign-in attempts. Wait a few minutes and try again.",
  account_not_linked:
    "This GitHub account could not be matched to an existing user. Ask an administrator for help.",
};

const GENERIC_MESSAGE = "Sign in failed. Please try again.";

export function loginErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code]! : GENERIC_MESSAGE;
}
