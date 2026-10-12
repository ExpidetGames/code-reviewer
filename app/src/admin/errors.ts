// SPDX-License-Identifier: Apache-2.0

// The stable error codes of the admin data routes and the HTTP status of each. The pages translate a
// code to copy (ui/messages.ts), never the other way round. A code never contains a secret.
import { SIGN_IN_METHODS_ERROR_CODES } from "./sign-in-methods.ts";

export const ADMIN_ERROR_CODES = [
  /** The request does not come from this site. */
  "cross_site_request",
  /** The body must be application/json. */
  "unsupported_content_type",
  /** The body is larger than the portal accepts. */
  "body_too_large",
  /** The body is not valid; `issues` names the fields. */
  "invalid_input",
  /** Multi-tenant to single-tenant with more than one workspace; `count` says how many. */
  "too_many_workspaces",
  /** The test mail was asked for too often; `Retry-After` says when to try again. */
  "rate_limited",
  /** The counters of a limit could not be read, so the request was not served. */
  "unavailable",
  ...SIGN_IN_METHODS_ERROR_CODES,
] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];

export const ADMIN_ERROR_STATUS: Record<AdminErrorCode, number> = {
  cross_site_request: 403,
  unsupported_content_type: 415,
  body_too_large: 413,
  invalid_input: 422,
  too_many_workspaces: 409,
  rate_limited: 429,
  unavailable: 503,
  at_least_one_method: 422,
  github_not_configured: 409,
  admin_needs_github_identity: 409,
};
