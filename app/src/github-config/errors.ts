// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable error codes of the GitHub data routes of the admin portal and the HTTP status of each. The
// pages translate a code to copy (ui/messages.ts), never the other way round. A code never contains a
// secret, a one-time code or a state.
export const GITHUB_ERROR_CODES = [
  /** The request does not come from this site. */
  "cross_site_request",
  /** The body must be application/json. */
  "unsupported_content_type",
  /** The body is larger than the route accepts. */
  "body_too_large",
  /** The body is not valid; `issues` names the fields. */
  "invalid_input",
  /** A GitHub App is configured already; replacing it has to be asked for. */
  "already_configured",
  /** The App is still in the environment of an installation that was not imported: enter it in the form. */
  "app_not_in_database",
  /** Asked too often; `Retry-After` says when to try again. */
  "rate_limited",
  /** The counters of a limit (or the database) could not be read, so the request was not served. */
  "unavailable",
  /** The request has no session to bind a state to. */
  "session_required",
  /** The "private app" flag has to be true or false. */
  "private_app_invalid",
  "not_configured",
  "app_auth_failed",
  "github_unreachable",
  /** The user authorization (client id and secret) is not configured, so there is nothing to authorize. */
  "github_not_configured",
] as const;
export type GithubErrorCode = (typeof GITHUB_ERROR_CODES)[number];

export const GITHUB_ERROR_STATUS: Record<GithubErrorCode, number> = {
  cross_site_request: 403,
  unsupported_content_type: 415,
  body_too_large: 413,
  invalid_input: 422,
  already_configured: 409,
  app_not_in_database: 409,
  rate_limited: 429,
  unavailable: 503,
  session_required: 401,
  private_app_invalid: 422,
  not_configured: 409,
  app_auth_failed: 422,
  github_unreachable: 503,
  github_not_configured: 409,
};
