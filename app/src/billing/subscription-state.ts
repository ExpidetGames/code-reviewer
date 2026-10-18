// SPDX-License-Identifier: Apache-2.0

// The vocabulary of the subscription state and of the webhook (#441, ADR 0005, 2.12): the statuses Paddle gives a
// subscription, the intervals a plan is sold in and the outcome codes of a delivered event. Stable codes: callers branch on
// them, the UI translates them. The database restates the statuses and intervals in check constraints
// (migration `20261018180000_create_billing_subscriptions`) and a test compares the lists.
import "server-only";

export const SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "paused",
  "canceled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** What Paddle may have scheduled for a subscription (`scheduled_change.action`). */
export const SCHEDULED_CHANGE_ACTIONS = ["cancel", "pause", "resume"] as const;
export type ScheduledChangeAction = (typeof SCHEDULED_CHANGE_ACTIONS)[number];

/**
 * What became of a delivered event. Stored with the event (`billing_webhook_events.outcome`), never the payload.
 *
 * - `applied`: the state changed (or, for a price event, the cache was refreshed).
 * - `duplicate_ignored`: the event id was seen already; only ever answered, the stored row keeps the first outcome.
 * - `stale_ignored`: older than what is applied; recorded, nothing changed.
 * - `price_unmapped`: the subscription's price belongs to no version it may move to; the state is kept.
 * - `workspace_unresolved`: no checkout of ours leads to a workspace; the state is kept.
 * - `second_live_subscription`: the workspace holds a live subscription already; flagged for the operator, not applied.
 * - `status_unknown`: a status the app does not know (Paddle added one); the state is kept.
 * - `payload_invalid`: signed by Paddle, but the data does not have the shape the app reads; the state is kept.
 * - `ignored_type`: an event type the app does not handle.
 * - `informational`: a type the app handles by recording it only; the subscription events carry the state.
 * - `price_not_tracked`: a price event about a price no plan links.
 */
export const WEBHOOK_OUTCOMES = [
  "applied",
  "duplicate_ignored",
  "stale_ignored",
  "price_unmapped",
  "workspace_unresolved",
  "second_live_subscription",
  "status_unknown",
  "payload_invalid",
  "ignored_type",
  "informational",
  "price_not_tracked",
] as const;
export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number];

/** The outcome of an event whose transaction has not finished; no committed row keeps it. */
export const WEBHOOK_PENDING = "pending";
