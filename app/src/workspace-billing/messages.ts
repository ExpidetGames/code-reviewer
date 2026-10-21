// SPDX-License-Identifier: Apache-2.0

// The words of the billing page of a workspace (ADR 0006, 2.5; #505). Fixed sentences: the UI translates the stable codes of the
// routes, never the other way round. The page speaks of FINAL prices only: nothing here names a rate, a formula, a minute count,
// the real cost of our key, a model or a provider, and the hidden hourly brake is never mentioned. The maintainer's decisions
// show in the copy: prepaid US dollars, for businesses; a top-up of 10 to 500 US dollars; no auto-recharge; credit never expires
// and is not refunded by us; a balance can go below zero after a review and then blocks new reviews until it is topped up.
import {
  CROSS_SITE_REQUEST,
  INVALID_VALUES,
  REQUEST_NOT_UNDERSTOOD,
  ROLE_NOT_ALLOWED,
  TOO_MANY_ATTEMPTS,
  UNAVAILABLE,
} from "../copy/messages.ts";
import type { RequestIssue } from "../ui/json-request.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../ui/transport-messages.ts";
import type { JournalRowKind, WorkspaceKeyMode } from "./view.ts";

export const BILLING_PAGE_TITLE = "Billing";
export const BILLING_NAV_LABEL = "Billing";

export const BALANCE_HEADING = "Balance";
export const HELD_TEXT = "Held by running reviews";
export const BALANCE_EXPLAINER =
  "Credit is prepaid in US dollars and never expires. Each review is charged when it ends, at its final price.";

/** Why reviews are paused, and the way out, for a balance of zero and for one below zero. */
export const EMPTY_BALANCE = {
  title: "No credit left",
  body: "New reviews are not started until credit is added.",
  ownerAction: "Add credit below to continue.",
  memberAction: "Ask an Owner or Admin of this workspace to add credit.",
} as const;
export const NEGATIVE_BALANCE = {
  title: "The balance is below zero",
  body: "A review that was running when the credit ran out, or a refund, took the balance below zero. New reviews are not started until it is above zero again.",
  ownerAction: "Add credit below to continue.",
  memberAction: "Ask an Owner or Admin of this workspace to add credit.",
} as const;

export const TOP_UP_HEADING = "Add credit";
export const TOP_UP_EXPLAINER =
  "Top up between $10 and $500. There is no automatic recharge. Credit is not refunded by us.";
export const MANUAL_TOP_UP_TEXT =
  "Credit for this workspace is added by the operator of this instance. Ask your operator to add credit.";
export const PRESET_LABEL = "Amount";
export const CUSTOM_AMOUNT_LABEL = "Other amount (USD)";
export const BUSINESS_CONFIRMATION_LABEL =
  "I confirm that I am buying for a business and not as a consumer. Credit is a prepayment for reviews, has no cash value, cannot be transferred and is not refunded by us.";
export const BUSINESS_CONFIRMED_TEXT =
  "You confirmed that this workspace buys for a business.";
export const TERMS_LINK_TEXT = "Terms";
export const PAY_BUTTON = "Continue to payment";
export const PAY_BUTTON_LOADING = "Preparing the payment";
export const PAYMENT_HINT =
  "You pay on the page of our payment provider and come back here. The balance rises as soon as the payment is confirmed.";

export const PROFILE_HEADING = "Billing details";
export const PROFILE_EXPLAINER =
  "The name and address that go on your receipt, and an optional VAT ID. Only Owners and Admins see them.";
export const PROFILE_FIELD_LABELS = {
  legalName: "Legal name",
  country: "Country (two-letter code, for example DE)",
  addressLine1: "Address",
  addressLine2: "Address, second line (optional)",
  postalCode: "Postal code",
  city: "City",
  vatId: "VAT ID (optional)",
} as const;
export const PROFILE_SAVE_BUTTON = "Save billing details";
export const PROFILE_SAVED_TEXT = "Billing details saved.";

export const PENDING_HEADING = "Payments on their way";
export const PENDING_EXPLAINER =
  "A payment that was started and has not been confirmed yet. If a payment is not credited after a few minutes, check it.";
export const CHECK_PAYMENT_BUTTON = "Check payment";
export const CHECK_PAYMENT_LOADING = "Checking the payment";
export const CHECK_RESULT: Record<string, string> = {
  paid: "The payment arrived and the credit is added.",
  pending: "The payment has not been confirmed yet. Check again in a moment.",
  failed: "The payment did not go through. Start a new one.",
  expired: "The payment page expired. Start a new one.",
};

export const RETURN_SUCCESS =
  "Thank you. Your payment is on its way; the balance rises as soon as it is confirmed.";
export const RETURN_CANCELLED =
  "The payment was cancelled. Nothing was charged.";

export const JOURNAL_HEADING = "Journal";
export const JOURNAL_EMPTY = "Nothing has been booked yet.";
export const JOURNAL_MORE_BUTTON = "Show older entries";
export const JOURNAL_MORE_LOADING = "Loading older entries";
export const JOURNAL_ROW_LABEL: Record<JournalRowKind, string> = {
  top_up: "Credit added",
  start_credit: "Start credit",
  usage: "Review",
  refund: "Refund",
  chargeback: "Chargeback",
  correction: "Correction by the operator",
};

export const LIMIT_HEADING = "Monthly spending limit";
export const LIMIT_EXPLAINER =
  "An optional limit on what this workspace spends per month (UTC). When this month's charges have reached it, new reviews are not started until the next month or until you raise it. Reviews that are already running always finish.";
export const LIMIT_LABEL = "Monthly limit (USD, empty for no limit)";
export const LIMIT_SAVE_BUTTON = "Save limit";
export const LIMIT_SAVED_TEXT = "Limit saved.";
export const LIMIT_CLEARED_TEXT = "Limit removed.";
export const LIMIT_MIN_MAX_TEXT = "Enter an amount from $1 to $1,000,000.";

export const KEY_HEADING = "Which key reviews run on";
export const KEY_TEXT: Record<WorkspaceKeyMode, string> = {
  managed:
    "Reviews run on our models and are charged an AI price and an infrastructure price.",
  own: "Reviews run on your own key and are charged the infrastructure price only. You pay your model provider for the AI yourself.",
  none: "The key your reviews run on cannot be read right now.",
};
export const KEY_LINK_TEXT = "Choose the key on the LLM access page";

export const INVOICES_TEXT =
  "Invoices and receipts are issued and emailed by Link, the seller of record for your payments.";
export const INVOICES_LINK_TEXT = "link.com";
export const INVOICES_LINK_HREF = "https://link.com";

export const READ_ONLY_TEXT =
  "You can see the balance and the journal. Owners and Admins add credit and change the billing details and the limit.";

const FAILURE_COPY: Record<string, string> = {
  cross_site_request: CROSS_SITE_REQUEST,
  unsupported_content_type: REQUEST_NOT_UNDERSTOOD,
  body_too_large: "The request was too large. Shorten the text and try again.",
  invalid_input: INVALID_VALUES,
  forbidden: ROLE_NOT_ALLOWED,
  rate_limited: TOO_MANY_ATTEMPTS,
  top_ups_busy: UNAVAILABLE,
  limits_unavailable: UNAVAILABLE,
  amount_invalid: "Enter an amount in US dollars, for example 25 or 25.50.",
  amount_out_of_range: "Enter an amount from $10 to $500.",
  intent_id_invalid:
    "The payment could not be recognized. Reload the page and try again.",
  checkout_unavailable: "Payments are not available for this workspace.",
  profile_required: "Save your billing details first.",
  business_confirmation_required:
    "Confirm that you are buying for a business to continue.",
  intent_conflict:
    "This payment was started already. Reload the page and start a new one.",
  request_in_progress:
    "The payment is being prepared. Wait a moment and try again.",
  provider_unavailable:
    "The payment provider could not be reached. Try again in a moment.",
  provider_rejected:
    "The payment provider refused the request. Check your billing details and try again.",
  provider_not_configured: UNAVAILABLE,
  vat_id_rejected: "The payment provider did not accept the VAT ID.",
  intent_not_found: "That payment is not known. Reload the page.",
  limit_invalid: LIMIT_MIN_MAX_TEXT,
  limit_out_of_range: LIMIT_MIN_MAX_TEXT,
  journal_query_invalid: "The journal could not be loaded. Reload the page.",
};

/** The sentence for a stable code of a billing route of a workspace, or a transport failure. */
export function describeBillingFailure(code: string): string {
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

const ISSUE_COPY: Record<string, string> = {
  required: "Fill in this field.",
  too_long: "This is too long.",
  invalid_characters: "Remove line breaks and special characters.",
  country_unknown: "Use the two-letter code of the country, for example DE.",
  vat_id_invalid: "This does not look like a VAT ID of that country.",
  vat_country_unsupported:
    "A VAT ID is not asked for in this country. Leave the field empty.",
};

/** The sentence under the field a billing detail was refused for. */
export function describeProfileIssue(issue: RequestIssue): string {
  return (
    (Object.hasOwn(ISSUE_COPY, issue.code)
      ? ISSUE_COPY[issue.code]
      : undefined) ?? GENERIC_FAILURE
  );
}

/** The banner on the workspace pages for an Owner and an Admin while the balance is low, zero or below zero (#506). */
export const BANNER_COPY = {
  low: {
    title: "Your balance is low",
    body: "Reviews keep starting while there is credit. Add credit so they do not stop.",
  },
  empty: {
    title: "No credit left",
    body: "New reviews are not started until credit is added.",
  },
  negative: {
    title: "The balance is below zero",
    body: "New reviews are not started until the balance is above zero again.",
  },
} as const;
export const BANNER_BALANCE_LABEL = "Balance";
export const BANNER_LINK_TEXT = "Go to billing";
