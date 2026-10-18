// SPDX-License-Identifier: Apache-2.0

// `subscription.created`, `.updated` and `.canceled` (#441, ADR 0005, 2.12): the events that carry the state of a subscription. They
// run inside the transaction of the handler, after the event id was claimed.
//
// Who a new subscription belongs to is decided by data the app wrote itself: `subscription.created` names the Paddle transaction that
// made it (`transaction_id`), and the checkout row the server wrote for that transaction names the workspace and the plan version.
// `custom_data` is only a cross-check: it can never name a workspace, and one that names another workspace than the checkout does
// leaves the subscription unresolved. Every later event is found by the Paddle subscription id of a row we wrote.
//
// What an event may change: the status, the periods, the scheduled change and, through a plan change, the price and the version
// (`price-resolution.ts`). The state is replaced as a whole, and only if the event is not older than the last applied one (the
// statement that writes decides, `applyEvent`). No outbound call.
import "server-only";
import { createBillingCheckoutsRepository } from "../db/repositories/billing-checkouts-repository.ts";
import { createBillingCustomersRepository } from "../db/repositories/billing-customers-repository.ts";
import { createBillingDirectoryRepository } from "../db/repositories/billing-directory-repository.ts";
import {
  createBillingSubscriptionsRepository,
  type SubscriptionPatch,
  type SubscriptionRow,
} from "../db/repositories/billing-subscriptions-repository.ts";
import { resolveVersionForPrice } from "./price-resolution.ts";
import {
  SCHEDULED_CHANGE_ACTIONS,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  type WebhookOutcome,
} from "./subscription-state.ts";
import type { ApplyContext } from "./webhook-context.ts";
import {
  canonicalTime,
  webhookSubscriptionSchema,
  type WebhookSubscription,
} from "./webhook-schemas.ts";

/** The status the event shows; `subscription.canceled` is canceled whatever the snapshot says. */
function statusOf(
  eventType: string,
  subscription: WebhookSubscription,
): SubscriptionStatus | undefined {
  if (eventType === "subscription.canceled") return "canceled";
  return SUBSCRIPTION_STATUSES.find((status) => status === subscription.status);
}

/** The one price the subscription is billed with: exactly one live item of quantity one, else undefined. */
function singlePriceId(subscription: WebhookSubscription): string | undefined {
  const live = subscription.items.filter((item) => item.status !== "inactive");
  const [only] = live;
  return live.length === 1 && only?.quantity === 1 ? only.price.id : undefined;
}

/** A time field of the payload: null stays null, text becomes canonical, anything else is `invalid`. */
function timeField(text: string | null | undefined): string | null | "invalid" {
  if (text === null || text === undefined) return null;
  return canonicalTime(text) ?? "invalid";
}

type Times = {
  startedAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextBilledAt: string | null;
  canceledAt: string | null;
  scheduledChangeAction: SubscriptionPatch["scheduledChangeAction"];
  scheduledChangeAt: string | null;
};

function timesOf(
  subscription: WebhookSubscription,
  status: SubscriptionStatus,
  occurredAt: string,
): Times | undefined {
  const started = timeField(subscription.started_at);
  const next = timeField(subscription.next_billed_at);
  const canceled = timeField(subscription.canceled_at);
  const start = timeField(subscription.current_billing_period?.starts_at);
  const end = timeField(subscription.current_billing_period?.ends_at);
  const change = timeField(subscription.scheduled_change?.effective_at);
  if ([started, next, canceled, start, end, change].includes("invalid"))
    return undefined;
  const action = SCHEDULED_CHANGE_ACTIONS.find(
    (candidate) => candidate === subscription.scheduled_change?.action,
  );
  return {
    startedAt: started as string | null,
    currentPeriodStart: start as string | null,
    currentPeriodEnd: end as string | null,
    nextBilledAt: next as string | null,
    // A canceled subscription has a cancellation time even if the snapshot lacks it.
    canceledAt:
      status === "canceled"
        ? ((canceled as string | null) ?? occurredAt)
        : (canceled as string | null),
    scheduledChangeAction: action ?? null,
    scheduledChangeAt: action === undefined ? null : (change as string | null),
  };
}

function alert(context: ApplyContext, outcome: string, subscriptionId: string) {
  context.logger.error(
    `[billing] BILLING_WEBHOOK_${outcome.toUpperCase()} event=${context.eventId} subscription=${subscriptionId}`,
  );
}

export async function applySubscriptionEvent(
  context: ApplyContext,
): Promise<WebhookOutcome> {
  const parsed = webhookSubscriptionSchema.safeParse(context.data);
  if (!parsed.success) return "payload_invalid";
  const subscription = parsed.data;
  const status = statusOf(context.eventType, subscription);
  if (status === undefined) return "status_unknown";
  const times = timesOf(subscription, status, context.occurredAt);
  if (times === undefined) return "payload_invalid";

  const directory = createBillingDirectoryRepository(context.db);
  const workspaceId = await directory.workspaceOfSubscription(
    context.env,
    subscription.id,
  );
  if (workspaceId !== undefined)
    return applyToExisting(context, workspaceId, subscription, status, times);
  if (context.eventType !== "subscription.created")
    return "workspace_unresolved";
  return createFromCheckout(context, subscription, status, times);
}

async function applyToExisting(
  context: ApplyContext,
  workspaceId: string,
  subscription: WebhookSubscription,
  status: SubscriptionStatus,
  times: Times,
): Promise<WebhookOutcome> {
  const subscriptions = createBillingSubscriptionsRepository(
    context.db,
    workspaceId,
    context.now,
  );
  const row = await subscriptions.getByPaddleId(context.env, subscription.id);
  if (row === undefined) return "workspace_unresolved";

  const priceId = singlePriceId(subscription);
  const unchanged = priceId === row.paddlePriceId;
  const resolved = unchanged
    ? { versionId: row.planVersionId, interval: row.billingInterval }
    : priceId === undefined
      ? undefined
      : await resolveVersionForPrice(
          context.db,
          context.env,
          priceId,
          row.planVersionId,
          { strict: false },
        );
  // A price no version sells keeps the state, except that the end of a subscription is always believed: a canceled subscription
  // must not stay active because its last price is not one of ours.
  if (resolved === undefined && status !== "canceled") {
    alert(context, "price_unmapped", subscription.id);
    return "price_unmapped";
  }
  const version = resolved ?? {
    versionId: row.planVersionId,
    interval: row.billingInterval,
  };
  const patch: SubscriptionPatch = {
    planVersionId: version.versionId,
    paddlePriceId: resolved === undefined ? row.paddlePriceId : (priceId ?? ""),
    billingInterval: version.interval,
    status,
    pastDueSince: pastDueSince(row, status, context.occurredAt),
    ...times,
  };
  const applied = await subscriptions.applyEvent(row.id, patch, {
    occurredAt: context.occurredAt,
    eventId: context.eventId,
  });
  return applied ? "applied" : "stale_ignored";
}

/** When this spell of `past_due` began: the first event that showed it, kept while it lasts, gone on recovery. */
function pastDueSince(
  row: SubscriptionRow | undefined,
  status: SubscriptionStatus,
  occurredAt: string,
): string | null {
  if (status !== "past_due") return null;
  if (row?.status === "past_due" && row.pastDueSince !== null)
    return row.pastDueSince;
  return occurredAt;
}

async function createFromCheckout(
  context: ApplyContext,
  subscription: WebhookSubscription,
  status: SubscriptionStatus,
  times: Times,
): Promise<WebhookOutcome> {
  const transactionId = subscription.transaction_id;
  if (transactionId === null || transactionId === undefined)
    return "workspace_unresolved";
  const workspaceId = await createBillingDirectoryRepository(
    context.db,
  ).workspaceOfCheckout(context.env, transactionId);
  if (workspaceId === undefined) return "workspace_unresolved";
  // The cross-check: what the payload says about a workspace must agree with the checkout, or nothing is applied.
  const claimed = subscription.custom_data?.workspace_id;
  if (claimed !== undefined && claimed !== workspaceId)
    return "workspace_unresolved";

  const checkout = await createBillingCheckoutsRepository(
    context.db,
    workspaceId,
    context.now,
  ).getByTransaction(context.env, transactionId);
  const priceId = singlePriceId(subscription);
  if (checkout === undefined) return "workspace_unresolved";
  const resolved =
    priceId === undefined
      ? undefined
      : await resolveVersionForPrice(
          context.db,
          context.env,
          priceId,
          checkout.planVersionId,
          { strict: true, interval: checkout.billingInterval },
        );
  if (resolved === undefined || priceId === undefined) {
    alert(context, "price_unmapped", subscription.id);
    return "price_unmapped";
  }

  const subscriptions = createBillingSubscriptionsRepository(
    context.db,
    workspaceId,
    context.now,
  );
  const inserted = await subscriptions.insert({
    env: context.env,
    paddleSubscriptionId: subscription.id,
    paddleCustomerId: subscription.customer_id,
    planVersionId: resolved.versionId,
    paddlePriceId: priceId,
    billingInterval: resolved.interval,
    status,
    pastDueSince: pastDueSince(undefined, status, context.occurredAt),
    ...times,
    stamp: { occurredAt: context.occurredAt, eventId: context.eventId },
  });
  if (!inserted.ok) {
    if (inserted.reason === "subscription_exists")
      return applyToExisting(context, workspaceId, subscription, status, times);
    // A second live subscription for the workspace (two checkouts): the index refused it. Flagged for the operator, not applied.
    alert(context, "second_live_subscription", subscription.id);
    return "second_live_subscription";
  }
  await createBillingCustomersRepository(
    context.db,
    workspaceId,
    context.now,
  ).adopt(context.env, subscription.customer_id);
  return "applied";
}
