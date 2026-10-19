// SPDX-License-Identifier: Apache-2.0

// The record of provider events, by `(provider, event id)` (table `billing_webhook_events`; ADR 0006, 2.12). The first
// idempotency layer: an event id is claimed inside the transaction that applies it, so two deliveries of one event, even
// at the same moment, apply it once (the second waits for the first on Postgres and finds its outcome; SQLite has one
// writer). The row holds an id, an outcome and, for a refund or a dispute, the order of its states: no payload, no
// amount, nothing of the customer, which is why the table is instance level (src/db/repositories/scoping.test.ts).
//
// Only some outcomes make an id final. An event whose intent was unknown (`intent_unresolved`) may be claimed again when
// the provider redelivers it: the top-up it belongs to can be known by then.
import "server-only";
import { sql, type Kysely } from "kysely";
import type { BillingEventOutcome } from "../../billing/adapter.ts";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

/** The outcomes that let the same event id be handled again. */
const REDELIVERABLE: readonly string[] = [
  "intent_unresolved",
] satisfies BillingEventOutcome[];

/** The outcomes that mean "this state of the refund or dispute was applied": a later event must not be older than it. */
const STATE_OUTCOMES = ["applied", "nothing_to_reverse"] as const;

export type EventClaim =
  { claimed: true } | { claimed: false; outcome: string };

export type BillingWebhookEventsRepository = {
  /**
   * Claims an event id for this transaction (call it inside the transaction that applies the event). The first claim is
   * `claimed: true`; a repeat is `claimed: false` with the outcome recorded, unless that outcome allows a redelivery.
   */
  claim(
    provider: string,
    eventId: string,
    receivedAt: string,
  ): Promise<EventClaim>;
  /** Records what came of the event. `subject` and `occurredAt` order the states of one refund or dispute. */
  finish(
    provider: string,
    eventId: string,
    outcome: BillingEventOutcome,
    order: { subject: string | null; occurredAt: string | null },
  ): Promise<void>;
  /** True when a state of the same refund or dispute that happened AFTER `occurredAt` was applied before. */
  hasNewerState(
    provider: string,
    subject: string,
    occurredAt: string,
  ): Promise<boolean>;
};

function normalize(time: string | null): string | null {
  return time === null ? null : formatTimestamp(new Date(time));
}

export function createBillingWebhookEventsRepository(
  db: Kysely<Database>,
): BillingWebhookEventsRepository {
  return {
    async claim(provider, eventId, receivedAt) {
      const inserted = await db
        .insertInto("billing_webhook_events")
        .values({
          provider,
          event_id: eventId,
          outcome: "processing",
          subject: null,
          occurred_at: null,
          received_at: normalize(receivedAt) ?? receivedAt,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("event_id")
        .executeTakeFirst();
      if (inserted !== undefined) return { claimed: true };

      const existing = await db
        .selectFrom("billing_webhook_events")
        .select("outcome")
        .where("provider", "=", provider)
        .where("event_id", "=", eventId)
        .executeTakeFirstOrThrow();
      if (
        existing.outcome !== "processing" &&
        !REDELIVERABLE.includes(existing.outcome)
      )
        return { claimed: false, outcome: existing.outcome };
      await db
        .updateTable("billing_webhook_events")
        .set({
          outcome: "processing",
          received_at: normalize(receivedAt) ?? receivedAt,
        })
        .where("provider", "=", provider)
        .where("event_id", "=", eventId)
        .execute();
      return { claimed: true };
    },

    async finish(provider, eventId, outcome, { subject, occurredAt }) {
      await db
        .updateTable("billing_webhook_events")
        .set({ outcome, subject, occurred_at: normalize(occurredAt) })
        .where("provider", "=", provider)
        .where("event_id", "=", eventId)
        .execute();
    },

    async hasNewerState(provider, subject, occurredAt) {
      const newer = await db
        .selectFrom("billing_webhook_events")
        .select("event_id")
        .where("provider", "=", provider)
        .where("subject", "=", subject)
        .where("outcome", "in", STATE_OUTCOMES)
        .where(sql`occurred_at`, ">", normalize(occurredAt))
        .limit(1)
        .executeTakeFirst();
      return newer !== undefined;
    },
  };
}
