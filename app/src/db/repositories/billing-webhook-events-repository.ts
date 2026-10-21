// SPDX-License-Identifier: Apache-2.0

// The record of provider events, by `(provider, event id)` (table `billing_webhook_events`; ADR 0006, 2.12). The first
// idempotency layer: an event id is claimed inside the transaction that applies it, so two deliveries of one event, even
// at the same moment, apply it once (the second waits for the first on Postgres and finds its outcome; SQLite has one
// writer). The row holds an id, an outcome and, for a refund or a dispute, the order of its states: no payload, no
// amount, nothing of the customer, which is why the table is instance level (src/db/repositories/scoping.test.ts).
//
// An event that moved money (or claimed to) and changed nothing in the ledger is recorded with `review_state = 'open'`
// (BILLING_REVIEW_OUTCOMES in src/billing/adapter.ts); `listReviews` is what the operator's page reads (#603). Closing a
// review keeps who closed it, when, why and, for a manual credit, the journal entry: an operator's own words and ids, nothing
// of the buyer.
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

/** An event an operator has to look at: ids and a code, never a payload. */
export type EventReview = {
  provider: string;
  eventId: string;
  outcome: string;
  /** 'payment:<id>', 'refund:<id>' or 'dispute:<id>': what the event was about, when it said. */
  subject: string | null;
  /** Whose payment it is, when the application could attribute the event to one of its intents; else null (#502). */
  workspaceId: string | null;
  intentId: string | null;
  receivedAt: string;
};

/** What an operator recorded when closing a review (#603): never the buyer's data, only the operator's note and the ids. */
export type ReviewResolution = {
  /** The user id of the instance admin. */
  resolvedBy: string;
  note: string;
  /** The journal entry of the manual credit or correction that repaired it, when there was one. */
  entryId: string | null;
  /** ISO 8601, UTC. */
  at: string;
};

export type ReviewState = "open" | "resolved";

/** A review as the operator's page lists it: the event, and how it was closed when it was. */
export type ReviewRecord = EventReview & {
  reviewState: ReviewState;
  /** Null while open, and for a review closed before the resolution was recorded. */
  resolution: ReviewResolution | null;
};

/** The intent an event was attributed to: two ids of our own, kept on the row so a review can say whose payment it is. */
export type EventAttribution = {
  workspaceId: string | null;
  intentId: string | null;
};

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
  /**
   * Records what came of the event. `subject` and `occurredAt` order the states of one refund or dispute. `review` opens
   * a review of the event (see above); `attribution` names the workspace and the intent the event belongs to when the
   * application knows them.
   */
  finish(
    provider: string,
    eventId: string,
    outcome: BillingEventOutcome,
    order: { subject: string | null; occurredAt: string | null },
    review?: boolean,
    attribution?: EventAttribution,
  ): Promise<void>;
  /** The events waiting for an operator, oldest first. */
  listOpenReviews(options: { limit: number }): Promise<EventReview[]>;
  /** The reviews in a state, newest first (by when the event arrived, then by its id), `limit` of them after `offset`. */
  listReviews(options: {
    state: ReviewState;
    limit: number;
    offset: number;
  }): Promise<ReviewRecord[]>;
  /** How many reviews are in a state: the badge of the menu and the pages of the list. */
  countReviews(state: ReviewState): Promise<number>;
  /** One review, open or resolved; undefined for an event that is not (or no longer) under review. */
  getReview(
    provider: string,
    eventId: string,
  ): Promise<ReviewRecord | undefined>;
  /**
   * Closes the review of an event an operator has dealt with (a manual credit or correction, "Check payment"), recording who
   * did it, when, why and with which journal entry. True when an open review was closed, false when there was none (unknown
   * event, not under review, already closed: the first resolution stays as it was). The outcome and the id stay as they were:
   * the event is final, only the flag changes.
   */
  resolveReview(
    provider: string,
    eventId: string,
    resolution?: ReviewResolution,
  ): Promise<boolean>;
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

const REVIEW_COLUMNS = [
  "provider",
  "event_id",
  "outcome",
  "subject",
  "workspace_id",
  "intent_id",
  "received_at",
  "review_state",
  "resolved_at",
  "resolved_by",
  "resolution_note",
  "resolution_entry_id",
] as const;

type ReviewRow = Pick<
  Database["billing_webhook_events"],
  (typeof REVIEW_COLUMNS)[number]
>;

function toReviewRecord(row: ReviewRow): ReviewRecord {
  return {
    provider: row.provider,
    eventId: row.event_id,
    outcome: row.outcome,
    subject: row.subject,
    workspaceId: row.workspace_id,
    intentId: row.intent_id,
    receivedAt: row.received_at,
    reviewState: row.review_state === "resolved" ? "resolved" : "open",
    // A review closed before the resolution was recorded has none of the details.
    resolution:
      row.resolved_at === null || row.resolved_by === null
        ? null
        : {
            resolvedBy: row.resolved_by,
            note: row.resolution_note ?? "",
            entryId: row.resolution_entry_id,
            at: row.resolved_at,
          },
  };
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
          review_state: null,
          workspace_id: null,
          intent_id: null,
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
          review_state: null,
          workspace_id: null,
          intent_id: null,
          resolved_at: null,
          resolved_by: null,
          resolution_note: null,
          resolution_entry_id: null,
          received_at: normalize(receivedAt) ?? receivedAt,
        })
        .where("provider", "=", provider)
        .where("event_id", "=", eventId)
        .execute();
      return { claimed: true };
    },

    async finish(
      provider,
      eventId,
      outcome,
      { subject, occurredAt },
      review,
      attribution,
    ) {
      await db
        .updateTable("billing_webhook_events")
        .set({
          outcome,
          subject,
          occurred_at: normalize(occurredAt),
          review_state: review === true ? "open" : null,
          workspace_id: attribution?.workspaceId ?? null,
          intent_id: attribution?.intentId ?? null,
        })
        .where("provider", "=", provider)
        .where("event_id", "=", eventId)
        .execute();
    },

    async listOpenReviews({ limit }) {
      const rows = await db
        .selectFrom("billing_webhook_events")
        .select([
          "provider",
          "event_id",
          "outcome",
          "subject",
          "workspace_id",
          "intent_id",
          "received_at",
        ])
        .where("review_state", "=", "open")
        .orderBy("received_at", "asc")
        .orderBy("event_id", "asc")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        provider: row.provider,
        eventId: row.event_id,
        outcome: row.outcome,
        subject: row.subject,
        workspaceId: row.workspace_id,
        intentId: row.intent_id,
        receivedAt: row.received_at,
      }));
    },

    async listReviews({ state, limit, offset }) {
      const rows = await db
        .selectFrom("billing_webhook_events")
        .select(REVIEW_COLUMNS)
        .where("review_state", "=", state)
        .orderBy("received_at", "desc")
        .orderBy("event_id", "desc")
        .limit(limit)
        .offset(offset)
        .execute();
      return rows.map(toReviewRecord);
    },

    async countReviews(state) {
      const row = await db
        .selectFrom("billing_webhook_events")
        .select((eb) => eb.fn.countAll<string | number>().as("total"))
        .where("review_state", "=", state)
        .executeTakeFirstOrThrow();
      return Number(row.total);
    },

    async getReview(provider, eventId) {
      const row = await db
        .selectFrom("billing_webhook_events")
        .select(REVIEW_COLUMNS)
        .where("provider", "=", provider)
        .where("event_id", "=", eventId)
        .where("review_state", "in", ["open", "resolved"])
        .executeTakeFirst();
      return row === undefined ? undefined : toReviewRecord(row);
    },

    async resolveReview(provider, eventId, resolution) {
      const closed = await db
        .updateTable("billing_webhook_events")
        .set({
          review_state: "resolved",
          ...(resolution === undefined
            ? {}
            : {
                resolved_at: normalize(resolution.at),
                resolved_by: resolution.resolvedBy,
                resolution_note: resolution.note,
                resolution_entry_id: resolution.entryId,
              }),
        })
        .where("provider", "=", provider)
        .where("event_id", "=", eventId)
        .where("review_state", "=", "open")
        .returning("event_id")
        .executeTakeFirst();
      return closed !== undefined;
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
