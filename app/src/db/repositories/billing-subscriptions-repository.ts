// SPDX-License-Identifier: Apache-2.0

// Access to the subscription of ONE workspace (`billing_subscriptions`; the factory takes the workspace id, see ../workspace-scope.ts;
// #441, ADR 0005, 2.12). The row is the state of the workspace's Paddle subscription, pinned to the plan version it bought.
// Ids, states and times only. Three rules live here because they must hold under concurrent deliveries:
//
// - a workspace holds one subscription that is not canceled: `insert` says `workspace_has_live_subscription` for a second one
//   (the partial unique index decides, `on conflict do nothing`, so no transaction is aborted on Postgres);
// - a Paddle subscription is one row: a second insert says `subscription_exists`;
// - an event changes the row only if its `occurred_at` is not older than the stamp of the last applied one, in the one
//   statement that writes, so two deliveries racing cannot put an old state over a new one. Equal stamps apply.
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { BillingSubscriptionsTable, Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import {
  BILLING_INTERVALS,
  SCHEDULED_CHANGE_ACTIONS,
  SUBSCRIPTION_STATUSES,
  type BillingInterval,
  type ScheduledChangeAction,
  type SubscriptionStatus,
} from "../../billing/subscription-state.ts";
import type { PaddleEnv } from "./billing-plan-prices-repository.ts";

/** What an event says about the subscription; all of it is replaced together. Times are canonical UTC text. */
export type SubscriptionPatch = {
  planVersionId: string;
  paddlePriceId: string;
  billingInterval: BillingInterval;
  status: SubscriptionStatus;
  pastDueSince: string | null;
  startedAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextBilledAt: string | null;
  canceledAt: string | null;
  scheduledChangeAction: ScheduledChangeAction | null;
  scheduledChangeAt: string | null;
};

/** The event that wrote the state: its `occurred_at` is the stamp the next event is compared with. */
export type EventStamp = { occurredAt: string; eventId: string };

export type NewSubscription = SubscriptionPatch & {
  env: PaddleEnv;
  paddleSubscriptionId: string;
  paddleCustomerId: string;
  stamp: EventStamp;
};

export type SubscriptionRow = SubscriptionPatch & {
  id: string;
  workspaceId: string;
  env: PaddleEnv;
  paddleSubscriptionId: string;
  paddleCustomerId: string;
  lastEventOccurredAt: string;
  lastEventId: string;
  createdAt: string;
  updatedAt: string;
};

export type InsertSubscriptionResult =
  | { ok: true; subscription: SubscriptionRow }
  | {
      ok: false;
      reason: "workspace_has_live_subscription" | "subscription_exists";
    };

export type BillingSubscriptionsRepository = {
  getByPaddleId(
    env: PaddleEnv,
    paddleSubscriptionId: string,
  ): Promise<SubscriptionRow | undefined>;
  /** The subscription that is not canceled, if the workspace has one. */
  getLive(): Promise<SubscriptionRow | undefined>;
  insert(input: NewSubscription): Promise<InsertSubscriptionResult>;
  /**
   * Replaces the state with what an event says, if the event is not older than the last one applied (ties apply). False when
   * the subscription is not this workspace's or the event is stale; nothing is written then.
   */
  applyEvent(
    id: string,
    patch: SubscriptionPatch,
    stamp: EventStamp,
  ): Promise<boolean>;
};

type Row = Selectable<BillingSubscriptionsTable>;

function toSubscription(row: Row): SubscriptionRow {
  const status = SUBSCRIPTION_STATUSES.find((value) => value === row.status);
  const interval = BILLING_INTERVALS.find(
    (value) => value === row.billing_interval,
  );
  if (status === undefined || interval === undefined)
    throw new Error(`Billing subscription ${row.id} has an unknown value.`);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    env: row.paddle_env === "live" ? "live" : "sandbox",
    paddleSubscriptionId: row.paddle_subscription_id,
    paddleCustomerId: row.paddle_customer_id,
    planVersionId: row.plan_version_id,
    paddlePriceId: row.paddle_price_id,
    billingInterval: interval,
    status,
    pastDueSince: row.past_due_since,
    startedAt: row.started_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    nextBilledAt: row.next_billed_at,
    canceledAt: row.canceled_at,
    scheduledChangeAction:
      SCHEDULED_CHANGE_ACTIONS.find(
        (value) => value === row.scheduled_change_action,
      ) ?? null,
    scheduledChangeAt: row.scheduled_change_at,
    lastEventOccurredAt: row.last_event_occurred_at,
    lastEventId: row.last_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function columnsOf(patch: SubscriptionPatch) {
  return {
    plan_version_id: patch.planVersionId,
    paddle_price_id: patch.paddlePriceId,
    billing_interval: patch.billingInterval,
    status: patch.status,
    past_due_since: patch.pastDueSince,
    started_at: patch.startedAt,
    current_period_start: patch.currentPeriodStart,
    current_period_end: patch.currentPeriodEnd,
    next_billed_at: patch.nextBilledAt,
    canceled_at: patch.canceledAt,
    scheduled_change_action: patch.scheduledChangeAction,
    scheduled_change_at: patch.scheduledChangeAt,
  };
}

export function createBillingSubscriptionsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => `bsub_${randomUUID().replaceAll("-", "")}`,
): BillingSubscriptionsRepository {
  async function byPaddleId(env: PaddleEnv, paddleSubscriptionId: string) {
    const row = await db
      .selectFrom("billing_subscriptions")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("paddle_env", "=", env)
      .where("paddle_subscription_id", "=", paddleSubscriptionId)
      .executeTakeFirst();
    return row === undefined ? undefined : toSubscription(row);
  }

  return {
    getByPaddleId: byPaddleId,

    async getLive() {
      const row = await db
        .selectFrom("billing_subscriptions")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("status", "<>", "canceled")
        .executeTakeFirst();
      return row === undefined ? undefined : toSubscription(row);
    },

    async insert(input) {
      const at = formatTimestamp(now());
      const id = newId();
      const inserted = await db
        .insertInto("billing_subscriptions")
        .values({
          id,
          workspace_id: workspaceId,
          paddle_env: input.env,
          paddle_subscription_id: input.paddleSubscriptionId,
          paddle_customer_id: input.paddleCustomerId,
          ...columnsOf(input),
          last_event_occurred_at: input.stamp.occurredAt,
          last_event_id: input.stamp.eventId,
          created_at: at,
          updated_at: at,
        })
        // Either unique index: no error, so a transaction around the insert is not aborted on Postgres.
        .onConflict((conflict) => conflict.doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows) !== 1) {
        const existing = await byPaddleId(
          input.env,
          input.paddleSubscriptionId,
        );
        return {
          ok: false,
          reason:
            existing === undefined
              ? "workspace_has_live_subscription"
              : "subscription_exists",
        };
      }
      const stored = await db
        .selectFrom("billing_subscriptions")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return { ok: true, subscription: toSubscription(stored) };
    },

    async applyEvent(id, patch, stamp) {
      const updated = await db
        .updateTable("billing_subscriptions")
        .set({
          ...columnsOf(patch),
          last_event_occurred_at: stamp.occurredAt,
          last_event_id: stamp.eventId,
          updated_at: formatTimestamp(now()),
        })
        .where("id", "=", id)
        .where("workspace_id", "=", workspaceId)
        // The guard is in the statement that writes: a text of fixed width compares as time.
        .where("last_event_occurred_at", "<=", stamp.occurredAt)
        .executeTakeFirst();
      return Number(updated.numUpdatedRows) === 1;
    },
  };
}
