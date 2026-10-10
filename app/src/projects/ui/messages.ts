// The copy for everything that can go wrong when a person activates a project or runs the sync.
// The routes answer with stable codes; this is where a code becomes a sentence (the UI translates
// codes, never the other way round). A code written out in a sentence is a bug, so an unknown code
// gets a generic one.
import type { SyncErrorCode } from "../../integrations/sync/errors.ts";
import type { TransportErrorCode } from "../../ui/json-request.ts";
import type { ProjectErrorCode } from "../errors.ts";

const FAILURE_COPY: Record<
  ProjectErrorCode | SyncErrorCode | TransportErrorCode,
  string
> = {
  PROJECT_REQUEST_INVALID:
    "The request was not understood. Reload the page and try again.",
  PROJECT_CROSS_SITE_REQUEST:
    "The request did not come from this page. Reload the page and try again.",
  PROJECT_BODY_TOO_LARGE:
    "The request was too large. Reload the page and try again.",
  PROJECT_CONTENT_TYPE_UNSUPPORTED:
    "The request was not understood. Reload the page and try again.",
  PROJECT_REPOSITORY_NOT_FOUND:
    "This repository does not exist any more. Reload the page.",
  PROJECT_REPOSITORY_UNAVAILABLE:
    "This repository is no longer available to the GitHub App, so it cannot be activated.",
  PROJECT_INTEGRATION_UNAVAILABLE:
    "The GitHub App installation of this repository is suspended or removed, so the repository cannot be activated.",
  SYNC_CROSS_SITE_REQUEST:
    "The request did not come from this page. Reload the page and try again.",
  UNAUTHENTICATED: "Your session has ended. Sign in again.",
  ACCESS_DENIED:
    "Your GitHub account is not allowed to use this Code Reviewer instance.",
  NETWORK_ERROR:
    "The server could not be reached. Check your connection and try again.",
  UNEXPECTED_RESPONSE:
    "The server answered with something unexpected. Reload the page and try again.",
};

const GENERIC_FAILURE = "Something went wrong. Reload the page and try again.";

function hasCopy(code: string): code is keyof typeof FAILURE_COPY {
  return Object.hasOwn(FAILURE_COPY, code);
}

/** The sentence for the code a route answered with (or a transport code). */
export function describeFailure(code: string): string {
  return hasCopy(code) ? FAILURE_COPY[code] : GENERIC_FAILURE;
}

const GENERIC_SYNC_PROBLEM = "GitHub could not be read.";

// The codes of the GitHub App provider's errors (the sync reports the code of the error it met). They
// are spelled out here because the UI may not import a provider (src/integrations/README.md, "The
// boundary"); a code that is not listed gets the generic sentence.
const SYNC_PROBLEM_COPY: Record<string, string> = {
  GITHUB_APP_CONFIG_INVALID:
    "The GitHub App settings are incomplete or not valid, so GitHub could not be asked.",
  GITHUB_APP_AUTH_FAILED:
    "GitHub refused the app's credentials. Check the app ID and the private key.",
  GITHUB_APP_FORBIDDEN:
    "GitHub refused the request: the app lacks a permission or the installation is suspended.",
  GITHUB_APP_NOT_FOUND: "GitHub does not know the installation any more.",
  GITHUB_APP_RATE_LIMITED:
    "GitHub's rate limit is reached. Try again in a few minutes.",
  GITHUB_APP_UNAVAILABLE:
    "GitHub could not be reached or had a problem. Try again later.",
  GITHUB_APP_REQUEST_FAILED: "GitHub answered with something unexpected.",
};

/** The sentence for the stable code of one problem the sync reported; nothing is lost, only translated. */
export function describeSyncProblem(code: string): string {
  return Object.hasOwn(SYNC_PROBLEM_COPY, code)
    ? (SYNC_PROBLEM_COPY[code] ?? GENERIC_SYNC_PROBLEM)
    : GENERIC_SYNC_PROBLEM;
}
