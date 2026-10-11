// SPDX-License-Identifier: Apache-2.0

// The copy for the error codes of the sign-up and the email verification routes (the UI translates a code
// to copy, never the other way round). Nothing here says whether an address has an account or is allowed:
// the routes do not, so neither does the copy.
import {
  PASSWORD_ERROR_COPY,
  type PasswordErrorCode,
} from "../../auth/password-policy.ts";
import type { RequestIssue } from "../../ui/json-request.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const FAILURE_COPY: Record<string, string> = {
  signup_closed:
    "Signing up is not open on this instance right now. Ask the person who runs it.",
  sign_up_disabled:
    "Signing up with an email address is switched off on this instance. Use the sign-in on the login page.",
  rate_limited: "Too many attempts. Wait a while and try again.",
  unavailable: "This is not available right now. Please try again later.",
  not_available:
    "Email is not set up on this instance, so there is nothing to confirm.",
  invalid_token:
    "The link or the password is not correct. Use the password you chose when you signed up with this link; a link from somebody else's sign-up cannot be completed.",
  token_expired: "This link has expired. Ask for a new one.",
  token_used:
    "This link was used already. If you cannot sign in, ask for a new one.",
  cross_site_request: "The request did not come from this page. Reload it.",
};

const FIELD_ISSUE_COPY: Record<string, string> = {
  invalid_email: "Enter a valid email address.",
};

/** The sentence for a failed call of the sign-up, the resend or the verification. */
export function describeSignUpFailure(
  code: string,
  issues: RequestIssue[] = [],
): string {
  for (const issue of issues) {
    if (Object.hasOwn(FIELD_ISSUE_COPY, issue.code))
      return FIELD_ISSUE_COPY[issue.code] ?? GENERIC_FAILURE;
    if (Object.hasOwn(PASSWORD_ERROR_COPY, issue.code))
      return PASSWORD_ERROR_COPY[issue.code as PasswordErrorCode];
  }
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}
