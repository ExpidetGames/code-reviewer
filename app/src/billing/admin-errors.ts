// SPDX-License-Identifier: Apache-2.0

// The stable error codes of the billing data routes of the admin portal and the HTTP status of each. The page
// translates a code to copy (src/admin/ui/billing-messages.ts), never the other way round. A code never contains a
// key, a secret or a Paddle answer.
import "server-only";

/** What is missing before billing can be switched on, each by its own code. */
export const BILLING_MISSING_ITEMS = [
  "api_key_missing",
  "webhook_secret_missing",
  "client_token_missing",
  "connection_check_failed",
] as const;
export type BillingMissingItem = (typeof BILLING_MISSING_ITEMS)[number];

/** Why the connection check, or a call to Paddle on the admin's behalf, did not succeed. */
export const BILLING_CHECK_ERROR_CODES = [
  /** No API key is stored. */
  "api_key_missing",
  /** The stored key cannot be decrypted (another APP_SECRET, or the row changed). */
  "api_key_unreadable",
  /** Paddle does not accept the key (or the key is not for this environment). */
  "paddle_key_rejected",
  /** Paddle asked us to slow down. */
  "paddle_rate_limited",
  /** Paddle did not answer in time, or could not be reached. */
  "paddle_unreachable",
  /** Paddle failed, refused the request, or answered with something the app cannot read. */
  "paddle_unavailable",
] as const;
export type BillingCheckErrorCode = (typeof BILLING_CHECK_ERROR_CODES)[number];

export const BILLING_ERROR_CODES = [
  /** The request does not come from this site. */
  "cross_site_request",
  /** The body must be application/json. */
  "unsupported_content_type",
  /** The body is larger than the route accepts. */
  "body_too_large",
  /** The body is not valid; `issues` names the fields. */
  "invalid_input",
  /** The database could not be read or written, so the request was not served. */
  "unavailable",
  /** The API key belongs to the other Paddle environment (sandbox or live). */
  "billing_environment_mismatch",
  /** Billing cannot be switched on yet; `missing` lists what is missing, by code. */
  "billing_incomplete",
  /** The environment and the credentials do not change while billing is on: switch it off first. */
  "billing_disable_first",
  /** A webhook secret is stored already; remove it before a new notification destination is created. */
  "webhook_secret_exists",
  ...BILLING_CHECK_ERROR_CODES,
] as const;
export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

export const BILLING_ERROR_STATUS: Record<BillingErrorCode, number> = {
  cross_site_request: 403,
  unsupported_content_type: 415,
  body_too_large: 413,
  invalid_input: 422,
  unavailable: 503,
  billing_environment_mismatch: 422,
  billing_incomplete: 409,
  billing_disable_first: 409,
  webhook_secret_exists: 409,
  api_key_missing: 409,
  api_key_unreadable: 409,
  paddle_key_rejected: 422,
  paddle_rate_limited: 429,
  paddle_unreachable: 502,
  paddle_unavailable: 502,
};
