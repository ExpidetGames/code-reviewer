// SPDX-License-Identifier: Apache-2.0

// Access to `billing_webhook_events` (#441, ADR 0005, 2.12 and 2.16): the dedupe and the log of the Paddle events. Instance level:
// an event arrives before the workspace it is about is known, and the row names no workspace. One row per `event_id` (never the
// notification id, which changes with a delivery). No payload is stored: the type, the stamp, the outcome and the Paddle id of the
// subscription or price the event was about.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import {
  WEBHOOK_PENDING,
  type WebhookOutcome,
} from "../../billing/subscription-state.ts";
import type { PaddleEnv } from "./billing-plan-prices-repository.ts";

export type WebhookEventInput = {
  eventId: string;
  env: PaddleEnv;
  eventType: string;
  /** Canonical UTC text (`formatTimestamp`). */
  occurredAt: string;
  /** The Paddle id of the subscription or price the event is about, for the operator reading the log. */
  entityId: string | null;
};

export type WebhookEventRow = WebhookEventInput & {
  outcome: WebhookOutcome | typeof WEBHOOK_PENDING;
  receivedAt: string;
};

export type BillingWebhookEventsRepository = {
  /**
   * Records the event as pending. True for the first delivery of this event id, false for every later one: the statement is
   * `insert ... on conflict do nothing`, so of several concurrent deliveries exactly one gets true, and on Postgres the others
   * wait for the first transaction to end (if it rolls back, one of them inserts).
   */
  claim(input: WebhookEventInput): Promise<boolean>;
  setOutcome(eventId: string, outcome: WebhookOutcome): Promise<void>;
  get(eventId: string): Promise<WebhookEventRow | undefined>;
};

export function createBillingWebhookEventsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): BillingWebhookEventsRepository {
  return {
    async claim(input) {
      const inserted = await db
        .insertInto("billing_webhook_events")
        .values({
          event_id: input.eventId,
          paddle_env: input.env,
          event_type: input.eventType,
          occurred_at: input.occurredAt,
          outcome: WEBHOOK_PENDING,
          entity_id: input.entityId,
          received_at: formatTimestamp(now()),
        })
        .onConflict((conflict) => conflict.doNothing())
        .executeTakeFirst();
      return Number(inserted.numInsertedOrUpdatedRows) === 1;
    },

    async setOutcome(eventId, outcome) {
      await db
        .updateTable("billing_webhook_events")
        .set({ outcome })
        .where("event_id", "=", eventId)
        .execute();
    },

    async get(eventId) {
      const row = await db
        .selectFrom("billing_webhook_events")
        .selectAll()
        .where("event_id", "=", eventId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        eventId: row.event_id,
        env: row.paddle_env === "live" ? "live" : "sandbox",
        eventType: row.event_type,
        occurredAt: row.occurred_at,
        outcome: row.outcome as WebhookEventRow["outcome"],
        entityId: row.entity_id,
        receivedAt: row.received_at,
      };
    },
  };
}
