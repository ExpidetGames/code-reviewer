// SPDX-License-Identifier: Apache-2.0

// The vocabulary of a top-up intent (ADR 0006, 2.13; #497): the row the application writes BEFORE any checkout exists and
// that alone maps a payment to a workspace. States, stable error codes and the shape the rest of the app sees.
import "server-only";

/** The two running totals of what a payment's credit lost again. */
export const TOPUP_DEBIT_BUCKETS = ["refund", "dispute"] as const;
export type TopUpDebitBucket = (typeof TOPUP_DEBIT_BUCKETS)[number];

export const TOPUP_INTENT_STATES = [
  "pending",
  "paid",
  "failed",
  "expired",
] as const;
export type TopUpIntentState = (typeof TOPUP_INTENT_STATES)[number];

/**
 * How long a top-up that was started and not paid can still be paid: the provider redelivers for three days, and a checkout
 * is open for a day (a delayed method takes a few more). A payment that arrives inside it is credited
 * (src/billing/apply-event.ts), a refund or dispute we cannot place waits for it, and a workspace is not deleted while it runs
 * (src/workspaces/delete-workspace.ts).
 */
export const PENDING_TOP_UP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export const TOPUP_INTENT_ERROR_CODES = [
  /** The amount is not a whole micro-USD amount from 10 to 500 USD. */
  "amount_out_of_range",
  /** The adapter id is not an id. */
  "adapter_invalid",
  /** A provider id is not an opaque id. */
  "ref_invalid",
  /** The intent has another id for that already, or another intent holds the payment. */
  "ref_conflict",
  /** A running total of refunds or disputes would go below zero or, with the other, above what the payment credited. */
  "debit_out_of_bounds",
] as const;
export type TopUpIntentErrorCode = (typeof TOPUP_INTENT_ERROR_CODES)[number];

export class TopUpIntentError extends Error {
  readonly code: TopUpIntentErrorCode;

  constructor(code: TopUpIntentErrorCode, message: string) {
    super(message);
    this.name = "TopUpIntentError";
    this.code = code;
  }
}

/** An intent as the rest of the app sees it. Amounts are micro-USD integers; timestamps are ISO 8601 text in UTC. */
export type TopUpIntent = {
  id: string;
  workspaceId: string;
  adapter: string;
  /** What WE asked for: the ceiling of the credit this intent can ever produce. */
  amountMicroUsd: number;
  state: TopUpIntentState;
  /** What the payment credited (net), 0 until it is paid: the ceiling of what refunds and disputes can take back. */
  creditedMicroUsd: number;
  /** The running totals of what refunds took back and of what disputes did; together at most `creditedMicroUsd`. */
  refundedMicroUsd: number;
  disputedMicroUsd: number;
  /**
   * What the buyer was charged, gross, in the provider's unit, pinned when the payment was credited (#502): the total a
   * refund or dispute that names only its own amount is related to. Null before the payment, and for a provider that did not say.
   */
  providerAmount: number | null;
  /** The currency of `providerAmount` (lower case ISO 4217), pinned with it: a refund or dispute in another one is no share of it. */
  providerCurrency: string | null;
  checkoutRef: string | null;
  paymentRef: string | null;
  createdAt: string;
  updatedAt: string;
};
