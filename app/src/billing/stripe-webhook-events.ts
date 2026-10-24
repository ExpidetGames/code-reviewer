// SPDX-License-Identifier: LicenseRef-Proprietary

// What Stripe is told when the admin page creates the webhook endpoint (#504): the address path of our route and the event
// types the Stripe adapter (#502) turns into normalized events (README, "The adapter seam": payments, refunds and disputes).
// Any other event type would only be delivered to be ignored.
import "server-only";

/** The route that takes the events (`POST /api/billing/webhook`, the same for every provider). */
export const BILLING_WEBHOOK_PATH = "/api/billing/webhook";

export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
] as const;
