// SPDX-License-Identifier: Apache-2.0

// The copy for what the GitHub data routes answer: one sentence per stable code (src/github-config/errors.ts,
// the issue codes of settings.ts and the outcomes of the manifest flow and of the linking). The codes are the
// contract, these sentences are only what the page shows.
import type { RequestIssue } from "../../ui/json-request.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const FAILURE_COPY: Record<string, string> = {
  cross_site_request: "The request did not come from this page. Reload it.",
  invalid_input: "Some of the values are not valid. Check the fields.",
  already_configured:
    "A GitHub App is configured already. Tick the box to replace it.",
  app_not_in_database:
    "This App is still configured with environment variables. Enter it in the form below to move it into the portal.",
  rate_limited:
    "Too many requests in a short time. Wait a few minutes and try again.",
  unavailable: "This is not available right now. Please try again later.",
  session_required: "Your session has ended. Sign in again.",
  not_configured: "There is no GitHub App to ask yet.",
  app_auth_failed:
    "GitHub refused the key of the App. The key does not belong to this App id.",
  github_unreachable:
    "GitHub could not be reached. Nothing was saved. Try again later.",
  github_not_configured:
    "Sign in with GitHub is not set up yet. Enter the client id and secret of the App first.",
  private_app_invalid: "Choose one of the two answers.",
};

export function describeGithubFailure(code: string): string {
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

/** The sentence for a problem with one field. */
export function describeGithubIssue(issue: RequestIssue): string {
  switch (issue.code) {
    case "app_id_required":
    case "app_id_invalid":
      return "Enter the App ID, the number at the top of the App's settings page.";
    case "slug_required":
    case "slug_invalid":
      return "Enter the slug: the last part of the App's public link, with letters, digits and dashes.";
    case "private_key_required":
      return "Enter the private key. The saved one only works for the App it was entered for, and this is another App id (or there is none saved).";
    case "private_key_invalid":
      return "This is not a private key. Paste the whole content of the .pem file, with or without line breaks.";
    case "app_auth_failed":
      return "GitHub refused this key for this App id. Check that the key belongs to this App.";
    case "slug_mismatch":
      return "GitHub knows this App under another slug. Check the slug.";
    case "webhook_secret_required":
      return "Enter the webhook secret. The saved one only works for the App it was entered for.";
    case "webhook_secret_invalid":
      return "The webhook secret contains a line break or another control character, or is too long.";
    case "client_id_required":
      return "Enter the client id of the App.";
    case "client_id_invalid":
      return "This is not a client id. It is on the App's settings page and looks like Iv1.0123456789abcdef.";
    case "client_secret_required":
      return "Enter the client secret. The saved one only works for the client id it was entered for.";
    case "client_secret_invalid":
      return "This is not a client secret: no spaces, 8 to 256 characters.";
    case "client_credentials_invalid":
      return "GitHub does not accept this client id and secret as a pair. Generate a new secret on the App's settings page and enter it.";
    case "private_app_invalid":
      return "Choose one of the two answers.";
    case "name_invalid":
      return "The name has to have 1 to 34 characters, without a line break.";
    case "organization_invalid":
      return "This is not the name of a GitHub organization (letters, digits and single dashes).";
    case "github_unreachable":
      return "GitHub could not be reached. Nothing was saved. Try again later.";
    default:
      return GENERIC_FAILURE;
  }
}

/** Why the manifest flow or the linking came back with nothing (the `github_error` of the page's address). */
const OUTCOME_ERRORS: Record<string, string> = {
  state_invalid:
    "The start of this step could not be recognized (it expired, was used already, or belongs to another session). Start again.",
  manifest_code_invalid:
    "GitHub did not accept the one-time code (it was used already, or expired). Nothing was saved. Start again.",
  github_unreachable:
    "GitHub could not be reached. Nothing was saved. Try again later.",
  conversion_response_invalid:
    "GitHub answered with something unexpected. Nothing was saved.",
  storing_failed:
    "The App was created at GitHub but its credentials could not be saved here. Delete the App on GitHub and start again.",
  rate_limited: "Too many requests in a short time. Wait a few minutes.",
  access_denied: "The authorization at GitHub was cancelled. Nothing changed.",
  authorization_failed:
    "GitHub did not complete the authorization. Nothing changed.",
  already_linked:
    "This account is linked to a GitHub account already. Nothing changed.",
  identity_belongs_to_other_user:
    "That GitHub account belongs to another user of this instance. Nothing changed.",
  identity_has_other_credentials:
    "That GitHub account belongs to a user who can also sign in with a password, so the two accounts are not joined. Nothing changed. Sign in as that user instead.",
  github_not_configured:
    "Sign in with GitHub is not set up yet. Enter the client id and secret of the App first.",
  unavailable: "This is not available right now. Please try again later.",
};

export function describeGithubOutcomeError(code: string): string {
  return (
    (Object.hasOwn(OUTCOME_ERRORS, code) ? OUTCOME_ERRORS[code] : undefined) ??
    GENERIC_FAILURE
  );
}

/** What the page says after something worked (the `github` of the page's address). */
const OUTCOMES: Record<string, string> = {
  created:
    "The GitHub App was created and its credentials are saved, encrypted. Install it on your account or organization next.",
  linked: "Your GitHub account is linked.",
  already_linked: "Your GitHub account was linked already.",
  merged:
    "Your GitHub account is linked, and the account that had it before was merged into this one. Its memberships and history are yours now.",
};

export function describeGithubOutcome(code: string): string | null {
  return Object.hasOwn(OUTCOMES, code) ? (OUTCOMES[code] ?? null) : null;
}

/** The permissions the manifest asks for, in the words of GitHub's settings page. */
export const PERMISSION_LABELS: Record<string, string> = {
  pull_requests: "Repository permissions > Pull requests: Read and write",
  issues: "Repository permissions > Issues: Read and write",
  contents: "Repository permissions > Contents: Read-only",
  metadata: "Repository permissions > Metadata: Read-only",
  emails: "Account permissions > Email addresses: Read-only",
  members: "Organization permissions > Members: Read-only",
};
