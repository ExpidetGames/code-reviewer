// SPDX-License-Identifier: Apache-2.0

// The copy for what the billing data routes answer: one sentence per stable code (src/billing/admin-errors.ts) and for
// the fields of the form. The codes are the contract, these sentences are only what the page shows.
import {
  CROSS_SITE_REQUEST,
  INVALID_VALUES,
  UNAVAILABLE,
} from "../../copy/messages.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import type { RequestIssue } from "../../ui/json-request.ts";

const FAILURE_COPY: Record<string, string> = {
  cross_site_request: CROSS_SITE_REQUEST,
  invalid_input: INVALID_VALUES,
  unavailable: UNAVAILABLE,
  billing_environment_mismatch:
    "This API key belongs to the other Paddle environment. A sandbox key (pdl_sdbx_…) goes with Sandbox, a live key (pdl_live_…) with Live.",
  billing_incomplete:
    "Billing cannot be switched on yet. The list above shows what is missing; fix it, check the connection and try again.",
  billing_disable_first:
    "Switch billing off first. The environment and the credentials do not change while billing is on.",
  webhook_secret_exists:
    "A webhook secret is saved already. Remove it first if Paddle should get a new notification destination.",
  api_key_missing: "Save the Paddle API key first.",
  api_key_unreadable:
    "The saved API key cannot be read. Enter it again and save.",
  paddle_key_rejected:
    "Paddle did not accept the API key. Check that it is active and belongs to the chosen environment.",
  paddle_rate_limited:
    "Paddle is limiting requests right now. Wait a minute and try again.",
  paddle_unreachable: "Paddle could not be reached. Try again in a moment.",
  paddle_unavailable:
    "Paddle failed to answer the request. Try again in a moment.",
};

/** The sentence for a failed change or call. */
export function describeBillingFailure(code: string): string {
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

/** The sentence for a problem with one field. */
export function describeBillingIssue(issue: RequestIssue): string {
  switch (issue.code) {
    case "api_key_invalid":
      return "This is not a Paddle API key. It starts with pdl_sdbx_ (sandbox) or pdl_live_ (live).";
    case "webhook_secret_invalid":
      return "This is not a usable webhook secret. Paste it without spaces.";
    case "client_token_invalid":
      return "Paste the client-side token without spaces.";
    case "client_token_required":
      return "Billing is on, so the client-side token has to stay. Switch billing off first to remove it.";
    case "grace_days_invalid":
      return "Enter a whole number of days from 0 to 90.";
    case "environment_invalid":
      return "Choose Sandbox or Live.";
    default:
      return INVALID_VALUES;
  }
}
