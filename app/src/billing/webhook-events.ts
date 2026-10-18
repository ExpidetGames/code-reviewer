// SPDX-License-Identifier: Apache-2.0

// The Paddle event types the webhook handler acts on (ADR 0005, 2.11): the notification destination is created
// with exactly these, so Paddle sends nothing else. The handler itself is #441.
import "server-only";

export const PADDLE_WEBHOOK_EVENTS = [
  "subscription.created",
  "subscription.updated",
  "subscription.canceled",
  "transaction.completed",
  "transaction.payment_failed",
  "price.created",
  "price.updated",
  "product.updated",
] as const;
export type PaddleWebhookEvent = (typeof PADDLE_WEBHOOK_EVENTS)[number];

/** Where Paddle posts its events: below the public address of this app. */
export const BILLING_WEBHOOK_PATH = "/api/billing/webhook";
