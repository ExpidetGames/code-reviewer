// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy for what the billing data routes answer: one sentence per stable code (src/billing/admin-errors.ts), per refused
// field and per item that keeps billing from being switched on (src/billing/readiness.ts). The codes are the contract, these
// sentences are only what the page shows.
import type { ProductIdentity } from "../../product-identity/identity.ts";
import {
  CROSS_SITE_REQUEST,
  INVALID_VALUES,
  NOT_AVAILABLE_TO_YOU,
  REQUEST_NOT_UNDERSTOOD,
  UNAVAILABLE,
} from "../../copy/messages.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import type { RequestIssue } from "../../ui/json-request.ts";

const FAILURE_COPY: Record<string, string> = {
  cross_site_request: CROSS_SITE_REQUEST,
  unsupported_content_type: REQUEST_NOT_UNDERSTOOD,
  body_too_large: "The request was too large. Shorten the text and try again.",
  invalid_input: INVALID_VALUES,
  unavailable: UNAVAILABLE,
  billing_not_ready:
    "Billing cannot be switched on yet. The list shows what is missing; fix it and try again.",
  billing_disable_first:
    "Switch billing off before you change or remove the Stripe key, the webhook secret, the payment adapter or the link to the terms, then switch it on again.",
  webhook_environment_mismatch:
    "The webhook endpoint at Stripe belongs to the other environment than the API key. A test key goes with test mode, a live key with live mode.",
  webhook_url_not_public:
    "The address of this app (BETTER_AUTH_URL) is not a public https address, so Stripe could not deliver events to it. Set the public https address and restart, or enter the webhook secret of an endpoint you made yourself.",
  webhook_endpoint_secret_unknown:
    "Stripe has a webhook endpoint for this app already, and Stripe shows its secret only when it is created. Enter the secret by hand, or replace the endpoint.",
  webhook_endpoint_unusable:
    "Stripe has a webhook endpoint for this app, but it is switched off or not set to send every event billing needs, so it would not deliver a payment. Switch billing off, then replace it here, or fix it in the Stripe dashboard.",
  webhook_endpoint_in_progress:
    "A webhook endpoint is being created right now. Wait a moment and reload.",
  webhook_secret_not_stored:
    "Stripe created the webhook endpoint but its secret could not be saved. The endpoint was removed again; try once more.",
  webhook_secret_not_returned:
    "Stripe did not return the signing secret of the new webhook endpoint. Try again, or enter the secret by hand.",
  workspace_not_found: NOT_AVAILABLE_TO_YOU,
  request_conflict:
    "This request was already made with another amount. Reload the page and enter it again.",
  review_not_found: "This row is not under review any more. Reload the page.",
  review_already_resolved:
    "This row was closed already (by you or by another admin). Reload the page to see how.",
  review_workspace_unknown:
    "This row names no workspace, so there is nobody to credit. Close it with a note, or credit the workspace on the Billing page.",
  review_has_no_intent:
    "This row names no top-up of ours, so there is nothing to check at Stripe.",
  payment_check_not_possible:
    "Stripe cannot be asked about this payment: billing has no Stripe adapter that can look a payment up, or it is not set up.",
  payment_check_unavailable:
    "Stripe could not be asked, or refused the question. Try again in a moment.",
  review_credit_type_mismatch:
    "This row calls for another kind of entry than the one asked for (a credit for a payment, a correction for a refund or a dispute). Reload the page.",
  intent_state_changed:
    "The top-up of this row changed since you loaded the page (a payment may have been applied). Reload the page, look at the balance and the top-up, then decide again.",
  api_key_missing: "Save the Stripe API key first.",
  api_key_unreadable:
    "The saved API key cannot be read. Enter it again and save.",
  stripe_key_rejected:
    "Stripe did not accept the API key. Check that it is active, has the permission to read the account and belongs to the environment you mean.",
  stripe_rate_limited:
    "Stripe is limiting requests right now. Wait a minute and try again.",
  stripe_unreachable: "Stripe could not be reached. Try again in a moment.",
  stripe_unavailable:
    "Stripe failed to answer the request. Try again in a moment.",
  stripe_managed_payments_unavailable:
    "Stripe accepts the API key, but this Stripe account is not enabled for Managed Payments. Enable it in the Stripe dashboard (Settings, Managed Payments) or wait for Stripe's approval, then try again.",
};

/**
 * The sentence for a failed change or call. With the HTTP status of the answer, an answer the page cannot read names it
 * (#690).
 */
export function describeBillingFailure(
  product: ProductIdentity,
  code: string,
  status?: number | null,
): string {
  return (
    describeTransportFailure(product, code, status) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

/** A plain identifier of Stripe: a code or a type. Anything else is not shown. */
const PLAIN_IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * What Stripe said about a failed call (the `stripe` field of an answer of the billing routes): the HTTP status, the type and
 * the code, only as plain identifiers, as one sentence to append to the one for the failure; empty when there is nothing to show.
 */
export function describeStripeDetail(detail: unknown): string {
  if (typeof detail !== "object" || detail === null) return "";
  const { status, code, type } = detail as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof status === "number" && Number.isInteger(status) && status >= 100)
    parts.push(`HTTP ${status}`);
  for (const part of [type, code])
    if (typeof part === "string" && PLAIN_IDENTIFIER.test(part))
      parts.push(part);
  return parts.length === 0 ? "" : ` Stripe said: ${parts.join(", ")}.`;
}

const ISSUE_COPY: Record<string, string> = {
  factor_invalid:
    "Enter the factor A as a decimal from 1 to 100, for example 5 or 1.2 (at most four decimals).",
  rate_invalid:
    "Enter the rate in US dollars per started minute, from 0 to 10, for example 0.013 (at most six decimals).",
  reserve_invalid:
    "Enter the reserve in US dollars of real model cost, from 0 to 50, for example 0.15.",
  start_credit_invalid:
    "Enter the start credit in US dollars, from 0 to 100. 0 switches it off.",
  low_balance_invalid:
    "Enter the low-balance threshold in US dollars, from 0 to 500.",
  hourly_limit_invalid:
    "Enter a whole number of started reviews per hour, from 1 to 100,000.",
  url_invalid:
    "The link must be an https address of a public website, written out in full (https://example.com/terms), with no user name or password and at most 2,048 characters.",
  adapter_invalid: "Choose the manual adapter or Stripe.",
  api_key_invalid:
    "This is not a Stripe API key. It starts with sk_test_ or rk_test_ (test mode) or sk_live_ or rk_live_ (live mode).",
  webhook_secret_invalid:
    "This is not a webhook signing secret. It starts with whsec_ and has no spaces.",
  body_invalid: INVALID_VALUES,
  type_invalid: "Choose a credit or a correction.",
  actor_required: "Sign in again to write an entry.",
  note_required: "Write a note that says why: it stays in the journal.",
  note_too_long: "The note is too long (500 characters at most).",
  amount_invalid:
    "Enter an amount in US dollars. A credit is more than 0; a correction is not 0.",
  amount_out_of_range: "Enter at most 10,000 US dollars at once.",
  request_id_required:
    "The request could not be recognized. Reload the page and try again.",
  request_id_invalid:
    "The request could not be recognized. Reload the page and try again.",
};

/** The sentence for the problem with one field. */
export function describeBillingIssue(issue: RequestIssue): string {
  return (
    (Object.hasOwn(ISSUE_COPY, issue.code)
      ? ISSUE_COPY[issue.code]
      : undefined) ?? GENERIC_FAILURE
  );
}

const MISSING_COPY: Record<string, string> = {
  factor_a_missing: "The factor A",
  minute_rate_diff_missing: "The rate per started minute for Diff reviews",
  minute_rate_dynamic_missing:
    "The rate per started minute for Dynamic reviews",
  diff_ai_reserve_missing: "The AI reserve of a Diff review",
  stripe_api_key_missing: "The Stripe API key",
  stripe_webhook_secret_missing:
    "The webhook secret (create the webhook endpoint, or enter the secret)",
  connection_check_missing: "A passing connection check",
  terms_url_missing: "The link to your terms",
  connection_check_failed:
    "The connection check failed just now: check the API key",
  dispatcher_lacks_vm_lifecycle:
    "A Dispatcher of an earlier release claimed a job within the last day: update it first (it does not report its VMs, so its jobs would be billed by wall clock)",
};

/** One line of the list of what is missing before billing can be switched on. */
export function describeMissingItem(item: string): string {
  return (
    (Object.hasOwn(MISSING_COPY, item) ? MISSING_COPY[item] : undefined) ??
    GENERIC_FAILURE
  );
}

/**
 * The banner on every page of the admin portal while billing is switched on but its setup is not complete (#632): the claim
 * refuses every review then (`billing_rates_incomplete`), so it must not wait for the admin to open the Billing page.
 */
export const BILLING_INCOMPLETE_TITLE =
  "Billing is switched on but not complete";
export const BILLING_INCOMPLETE_DETAIL =
  "Until it is complete, every review is refused, and each pull request gets a notice that no review ran. Missing:";
export const BILLING_INCOMPLETE_ACTION_LEAD = "Complete it on";
export const BILLING_INCOMPLETE_ACTION_LINK = "Billing";
export const BILLING_INCOMPLETE_ACTION_TAIL =
  ", or switch billing off there (reviews then run without charge).";
