// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable error codes of the billing data routes of the admin portal and the HTTP status of each. The page translates a
// code to copy (src/admin/ui/billing-messages.ts), never the other way round. A code never contains a key, a secret or an
// answer of Stripe.
import "server-only";
import { BILLING_RATE_ERROR_CODES } from "./rates.ts";
import { MANUAL_CREDIT_ERROR_CODES } from "./manual-credit.ts";
import type { DISPATCHER_LACKS_VM_LIFECYCLE } from "./dispatcher-features.ts";
import type { BillingMissingItem } from "./readiness.ts";

/**
 * What can keep an attempt to switch billing on from going through: the missing items, a fresh check that failed, and a
 * Dispatcher that does not report its VMs (#498).
 */
export type BillingNotReadyItem =
  | BillingMissingItem
  | "connection_check_failed"
  | typeof DISPATCHER_LACKS_VM_LIFECYCLE;

/** Why the connection check, or a call to Stripe on the admin's behalf, did not succeed. */
export const BILLING_CHECK_ERROR_CODES = [
  /** No API key is stored. */
  "api_key_missing",
  /** The stored key cannot be decrypted (another APP_SECRET, or the row changed). */
  "api_key_unreadable",
  /** Stripe does not accept the key (revoked, wrong, or without the permission to read the account). */
  "stripe_key_rejected",
  /** Stripe asked us to slow down. */
  "stripe_rate_limited",
  /** Stripe did not answer in time, or could not be reached. */
  "stripe_unreachable",
  /** Stripe failed, refused the request, or answered with something the app cannot read. */
  "stripe_unavailable",
  /** Stripe accepts the key, but refuses the request that asks for Managed Payments: the account is not enabled for it (#690). */
  "stripe_managed_payments_unavailable",
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
  /** Billing cannot be switched on yet; `missing` lists what is missing, by code. */
  "billing_not_ready",
  /** The adapter and the credentials do not change while billing is on: switch it off first. */
  "billing_disable_first",
  /** The webhook endpoint at Stripe is of the other environment than the API key (test or live). */
  "webhook_environment_mismatch",
  /** The public address of this app is not an https address that Stripe can reach (BETTER_AUTH_URL). */
  "webhook_url_not_public",
  /** Stripe has an endpoint for this app's address whose secret is not known here: enter the secret, or recreate it. */
  "webhook_endpoint_secret_unknown",
  /** Stripe has an endpoint for this app's address that is switched off or not told about every event billing handles. */
  "webhook_endpoint_unusable",
  /** Another request is creating the webhook endpoint right now. */
  "webhook_endpoint_in_progress",
  /** Stripe created the endpoint but its secret could not be stored; the endpoint was removed again, try once more. */
  "webhook_secret_not_stored",
  /** Stripe answered without the signing secret of the endpoint it created. */
  "webhook_secret_not_returned",
  /** No workspace has this id. */
  "workspace_not_found",
  /** The same request id was used before with another amount. */
  "request_conflict",
  /** No event is under review under this provider and event id (#603). */
  "review_not_found",
  /** The review was closed already; the first resolution stays (#603). */
  "review_already_resolved",
  /** A credit was asked for a row that names no workspace: there is nobody to credit (#603). */
  "review_workspace_unknown",
  /** The row names no top-up of ours, so there is nothing to check at the provider (#603). */
  "review_has_no_intent",
  /** Billing has no payment adapter that can look a payment up, or it cannot be asked now (#603). */
  "payment_check_not_possible",
  /** The payment provider could not be asked, or refused the question (#603). */
  "payment_check_unavailable",
  /** A credit from a review row named another type than the row calls for: a credit for a payment, a correction for a refund or a dispute (#603). */
  "review_credit_type_mismatch",
  /** The top-up of the row is not in the state the admin saw when asking for the credit (#603). */
  "intent_state_changed",
  ...BILLING_CHECK_ERROR_CODES,
] as const;
export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

/**
 * Never a 502 or a 504: the app sits behind proxies (Cloudflare) that replace the body of those two with their own page, and the
 * admin would see no code and no reason (#690). A failure of Stripe is a 503.
 */
export const BILLING_ERROR_STATUS: Record<BillingErrorCode, number> = {
  cross_site_request: 403,
  unsupported_content_type: 415,
  body_too_large: 413,
  invalid_input: 422,
  unavailable: 503,
  billing_not_ready: 409,
  billing_disable_first: 409,
  webhook_environment_mismatch: 422,
  webhook_url_not_public: 422,
  webhook_endpoint_secret_unknown: 409,
  webhook_endpoint_unusable: 409,
  webhook_endpoint_in_progress: 409,
  webhook_secret_not_stored: 503,
  webhook_secret_not_returned: 503,
  workspace_not_found: 404,
  request_conflict: 409,
  review_not_found: 404,
  review_already_resolved: 409,
  review_workspace_unknown: 409,
  review_has_no_intent: 409,
  payment_check_not_possible: 409,
  payment_check_unavailable: 503,
  review_credit_type_mismatch: 409,
  intent_state_changed: 409,
  api_key_missing: 409,
  api_key_unreadable: 409,
  stripe_key_rejected: 422,
  stripe_rate_limited: 429,
  stripe_unreachable: 503,
  stripe_unavailable: 503,
  stripe_managed_payments_unavailable: 422,
};

/** The codes a field of the form can be refused with (`issues[].code`): the rates and numbers, the credentials, the credit. */
export const BILLING_ISSUE_CODES = [
  ...BILLING_RATE_ERROR_CODES,
  ...MANUAL_CREDIT_ERROR_CODES.filter(
    (code) => code !== "workspace_not_found" && code !== "request_conflict",
  ),
  "adapter_invalid",
  "api_key_invalid",
  "webhook_secret_invalid",
  /** A link to the terms or the privacy statement is not an https address of a public host (#626). */
  "url_invalid",
  "body_invalid",
  "type_invalid",
  "request_id_required",
] as const;
export type BillingIssueCode = (typeof BILLING_ISSUE_CODES)[number];
