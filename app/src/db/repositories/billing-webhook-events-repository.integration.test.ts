// SPDX-License-Identifier: Apache-2.0

// #502 (note N7 of the review of #527): a review of a billing event can be closed. `resolveReview` turns an open review into
// a resolved one, once, and says whether it did; the event keeps its outcome and its id stays final. On SQLite and Postgres.
import { describe, expect, it } from "vitest";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../../test-support/billing-engines.ts";
import { createBillingWebhookEventsRepository } from "./billing-webhook-events-repository.ts";

const T = "2026-10-21T08:00:00.000Z";

function suite(engine: BillingEngine) {
  describe.skipIf(engine.skip)(
    `closing the review of a billing event on ${engine.name}`,
    () => {
      async function seeded() {
        const { db } = await engine.create();
        const events = createBillingWebhookEventsRepository(db);
        await events.claim("stripe", "evt_open", T);
        await events.finish(
          "stripe",
          "evt_open",
          "amount_rejected",
          { subject: "payment:pi_1", occurredAt: null },
          true,
        );
        await events.claim("stripe", "evt_fine", T);
        await events.finish("stripe", "evt_fine", "applied", {
          subject: null,
          occurredAt: null,
        });
        return { db, events };
      }

      // #502-N7
      it("closes an open review once, keeps the outcome and drops it from the list", async () => {
        const { db, events } = await seeded();

        const first = await events.resolveReview("stripe", "evt_open");
        const second = await events.resolveReview("stripe", "evt_open");

        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(await events.listOpenReviews({ limit: 10 })).toEqual([]);
        expect(
          await db
            .selectFrom("billing_webhook_events")
            .select(["event_id", "outcome", "review_state"])
            .where("event_id", "=", "evt_open")
            .execute(),
        ).toEqual([
          {
            event_id: "evt_open",
            outcome: "amount_rejected",
            review_state: "resolved",
          },
        ]);
        // The event id stays final: a redelivery is a repeat, not a second review.
        expect(await events.claim("stripe", "evt_open", T)).toEqual({
          claimed: false,
          outcome: "amount_rejected",
        });
      });

      // #502-N7
      it("closes nothing for an event that was not under review, of another provider, or unknown", async () => {
        const { events } = await seeded();

        expect(await events.resolveReview("stripe", "evt_fine")).toBe(false);
        expect(await events.resolveReview("other", "evt_open")).toBe(false);
        expect(await events.resolveReview("stripe", "evt_nothing")).toBe(false);
        expect(await events.listOpenReviews({ limit: 10 })).toHaveLength(1);
      });
    },
  );
}

for (const engine of BILLING_ENGINES) suite(engine);
