// SPDX-License-Identifier: Apache-2.0

// What the review routes answer and the review page shows (#603): plain data made of what the application stored about an
// event it did not apply, never the provider's payload, a buyer or an amount the provider sent. It lives beside the page, not
// in `src/billing/`, because that module is server-only and a client component may not reach it. The service
// (`src/billing/admin-review-service.ts`) produces it. The one amount in it is the one WE asked for in the top-up the row
// belongs to (our own intent), which is what a manual credit is prefilled with.

export const REVIEW_STATES = ["open", "resolved"] as const;
export type ReviewStateView = (typeof REVIEW_STATES)[number];

/** What the provider's reference of the event is: a payment, a refund or a dispute. */
export type ReviewSubjectKind = "payment" | "refund" | "dispute";

export type BillingReviewView = {
  provider: string;
  eventId: string;
  /** A review outcome (`BILLING_REVIEW_OUTCOMES`): the page turns it into a sentence. */
  outcome: string;
  /** The provider's object the event was about; null when the event did not say. */
  subject: { kind: ReviewSubjectKind; ref: string } | null;
  /** Whose payment it is, when the application could attribute the event to one of its intents. */
  workspace: { id: string; name: string; slug: string } | null;
  /** The top-up of ours the event was attributed to, with the provider's ids recorded on it. */
  intent: {
    id: string;
    state: string;
    /** What we asked for, in micro-USD. */
    amountMicroUsd: number;
    checkoutRef: string | null;
    paymentRef: string | null;
  } | null;
  receivedAt: string;
  state: ReviewStateView;
  resolution: {
    at: string;
    /** The admin who closed it, by name; null when that user no longer exists. */
    byName: string | null;
    note: string;
    /** The journal entry of the manual credit or correction that repaired it. */
    entryId: string | null;
  } | null;
  /** The manual entry the row is prefilled with; the amount is null where the application cannot know it. Null: no workspace. */
  suggestion: {
    type: "credit" | "correction";
    amountMicroUsd: number | null;
  } | null;
};

export type BillingReviewListView = {
  state: ReviewStateView;
  page: number;
  pageSize: number;
  /** The rows in this state, over all pages. */
  total: number;
  /** The rows that are open, whatever the state shown. */
  openTotal: number;
  rows: BillingReviewView[];
};
