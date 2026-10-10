// The copy for everything that can go wrong when a person loads the pull requests or starts a
// command. The routes answer with stable codes; this is where a code becomes a sentence (the UI
// translates codes, never the other way round). Nothing a response carried (a raw answer of GitHub,
// a token) is ever put into a sentence: the sentences are fixed. An unknown code gets a generic one.
import type { ManualReviewErrorCode } from "../errors.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const FAILURE_COPY: Record<ManualReviewErrorCode, string> = {
  MANUAL_REVIEW_REQUEST_INVALID:
    "The request was not understood. Reload the page and try again.",
  MANUAL_REVIEW_CROSS_SITE_REQUEST:
    "The request did not come from this page. Reload the page and try again.",
  MANUAL_REVIEW_BODY_TOO_LARGE:
    "The request was too large. Shorten the question and try again.",
  MANUAL_REVIEW_CONTENT_TYPE_UNSUPPORTED:
    "The request was not understood. Reload the page and try again.",
  MANUAL_REVIEW_PROJECT_NOT_FOUND:
    "This repository is not an active project. Switch it on in the project list first.",
  MANUAL_REVIEW_PULL_REQUEST_NOT_FOUND:
    "GitHub has no pull request with this number in this repository any more. The list was refreshed.",
  MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN:
    "That pull request is closed or merged, so nothing was started. The list was refreshed.",
  MANUAL_REVIEW_COMMAND_NOT_ALLOWED:
    "This command is switched off in the settings of this project.",
  MANUAL_REVIEW_APP_NOT_INSTALLED:
    "The GitHub App is not installed for this repository any more, or GitHub no longer lets it read the repository. Check the installation on GitHub, then sync the project list.",
  MANUAL_REVIEW_GITHUB_UNAVAILABLE:
    "GitHub could not be reached or answered with an error. Try again in a moment.",
};

function hasCopy(code: string): code is ManualReviewErrorCode {
  return Object.hasOwn(FAILURE_COPY, code);
}

/** The sentence for the code a route answered with (or a transport code). */
export function describeManualReviewFailure(code: string): string {
  if (hasCopy(code)) return FAILURE_COPY[code];
  return describeTransportFailure(code) ?? GENERIC_FAILURE;
}

/** Failures after which the list of pull requests is out of date and is loaded again. */
export function staleListFailure(code: string): boolean {
  return (
    code === "MANUAL_REVIEW_PULL_REQUEST_NOT_FOUND" ||
    code === "MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN"
  );
}

export const QUESTION_REQUIRED_COPY =
  "Write the question you want answered about this pull request.";
export const QUESTION_TOO_LONG_COPY = (max: number) =>
  `The question is too long. Keep it under ${max.toLocaleString("en-US")} characters.`;
