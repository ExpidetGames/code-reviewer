// SPDX-License-Identifier: LicenseRef-Proprietary

// Translates the `error` code in the login page URL to copy. The code comes from Better Auth (or
// from GitHub, for access_denied) and is untrusted: it only selects a message, it is never shown.

const MESSAGES: Readonly<Record<string, string>> = {
  access_denied:
    "You cancelled the sign in at GitHub. Sign in again if you want to use code-review.com.",
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
  // The sign in with GitHub applies the sign-up rule to the verified primary email address of the account
  // (docs/decisions/0001-editions-setup-and-accounts.md, section 2.5). Deliberately says nothing about who
  // is allowed.
  github_email_unverified:
    "GitHub reports no verified primary email address for your account. Verify one in your GitHub settings and sign in again.",
  email_not_allowed:
    "The email address of your GitHub account is not allowed to sign up on this code-review.com instance.",
  signup_closed:
    "Signing up is closed on this instance until its admin has set it up. Ask an admin for help.",
  email_exists_unverified:
    "An account with the email address of your GitHub account exists, but one of the two addresses is not verified, so the two are not joined. Sign in with your password, link GitHub from your account page, or verify the address.",
  github_identity_conflict:
    "The account with the email address of your GitHub account is linked to another GitHub account already. Sign in the way you did before.",
  check_failed:
    "We could not read the email addresses of your GitHub account. Please try again later; if it keeps failing, ask an admin to check the permissions of the GitHub App.",
  github_not_configured:
    "Signing in with GitHub is not set up on this instance. Use another way to sign in.",
  // Email and password.
  invalid_credentials: "The email address or the password is not correct.",
  rate_limited:
    "Too many sign-in attempts. Wait up to 15 minutes and try again.",
  // The password was right, and the address has to be verified first (src/signup/).
  email_not_verified:
    "Verify your email address first: open the link in the email we sent you, or ask for a new one.",
  // The server could not decide (this is not a wrong password).
  unavailable: "Sign in is not available right now. Please try again later.",
  // The admin switched this way of signing in off (Setup, Ways to sign in).
  sign_in_method_disabled:
    "This way of signing in is switched off on this instance. Use another one.",
  account_not_linked:
    "This GitHub account could not be matched to an existing user. Ask an administrator for help.",
};

const GENERIC_MESSAGE = "Sign in failed. Please try again.";

export function loginErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code]! : GENERIC_MESSAGE;
}
