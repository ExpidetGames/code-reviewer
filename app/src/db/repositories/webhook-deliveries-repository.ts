// Access to the webhook_deliveries table: the record of which deliveries were accepted, so that a
// redelivery (GitHub's "Redeliver" button, a retry after a timeout, a second request racing the
// first) does not produce a second trigger. The only code that reads or writes the table.
//
// The life of a row: `claim` inserts it with the outcome "processing"; `complete` records what came
// of the delivery; `release` removes a claim whose processing failed, so that the redelivery is
// handled again. A claim that is neither completed nor released (the process died) is taken over by
// the next request once its lease ran out. Old rows are pruned whenever a row is written.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

/** How long a delivery is remembered. GitHub keeps redeliveries available for about three days. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 7;

/**
 * How long a claim without an outcome counts as "being processed". Longer than any request can
 * take, so only a request that died leaves a claim that runs out.
 */
export const WEBHOOK_DELIVERY_PROCESSING_LEASE_MS = 5 * 60 * 1000;

/** What came of a delivery. Stored in the database, so a value is never renamed or reused. */
export const WEBHOOK_DELIVERY_OUTCOMES = [
  /** Claimed, not finished (the only state of a row that is still being handled). */
  "processing",
  /** Genuine, but nothing to do for it (an irrelevant action, an unidentified installation). */
  "ignored",
  /** The installation is not known and the delivery cannot introduce it. */
  "unknown_installation",
  /** The installation is suspended or removed, so its pull requests are not reviewed. */
  "integration_disabled",
  /** The platform said the actor may not start a review. */
  "trigger_not_allowed",
  /** A review trigger was handed to the intake. */
  "trigger_enqueued",
  /** The installation or its repositories were synchronized. */
  "installation_changed",
] as const;
export type WebhookDeliveryOutcome = (typeof WEBHOOK_DELIVERY_OUTCOMES)[number];

export type WebhookDeliveriesRepository = {
  /**
   * Records that this delivery is being handled. "claimed" for the first request with this id (and
   * for one that takes over an abandoned claim), "duplicate" for every other. Also prunes old rows.
   */
  claim(deliveryId: string, event: string): Promise<"claimed" | "duplicate">;
  /** Records what came of a claimed delivery. */
  complete(
    deliveryId: string,
    outcome: Exclude<WebhookDeliveryOutcome, "processing">,
  ): Promise<void>;
  /** Removes a claim that has no outcome, so that a redelivery is handled again. */
  release(deliveryId: string): Promise<void>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function createWebhookDeliveriesRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): WebhookDeliveriesRepository {
  return {
    async claim(deliveryId, event) {
      const current = now();

      await db
        .deleteFrom("webhook_deliveries")
        .where(
          "received_at",
          "<",
          formatTimestamp(
            new Date(
              current.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS,
            ),
          ),
        )
        .execute();

      // Both statements are single, atomic writes: of several simultaneous requests exactly one
      // inserts, and exactly one takes over an abandoned claim.
      const inserted = await db
        .insertInto("webhook_deliveries")
        .values({
          delivery_id: deliveryId,
          event,
          outcome: "processing",
          received_at: formatTimestamp(current),
        })
        .onConflict((conflict) => conflict.column("delivery_id").doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows) > 0) return "claimed";

      const takenOver = await db
        .updateTable("webhook_deliveries")
        .set({ event, received_at: formatTimestamp(current) })
        .where("delivery_id", "=", deliveryId)
        .where("outcome", "=", "processing")
        .where(
          "received_at",
          "<",
          formatTimestamp(
            new Date(current.getTime() - WEBHOOK_DELIVERY_PROCESSING_LEASE_MS),
          ),
        )
        .executeTakeFirst();
      return Number(takenOver.numUpdatedRows) > 0 ? "claimed" : "duplicate";
    },

    async complete(deliveryId, outcome) {
      await db
        .updateTable("webhook_deliveries")
        .set({ outcome })
        .where("delivery_id", "=", deliveryId)
        .execute();
    },

    async release(deliveryId) {
      await db
        .deleteFrom("webhook_deliveries")
        .where("delivery_id", "=", deliveryId)
        .where("outcome", "=", "processing")
        .execute();
    },
  };
}
