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

      async function withReviews() {
        const { db } = await engine.create();
        const events = createBillingWebhookEventsRepository(db);
        const record = async (
          id: string,
          at: string,
          outcome: "amount_rejected" | "intent_unresolved",
          subject: string,
          attribution?: { workspaceId: string; intentId: string },
        ) => {
          await events.claim("stripe", id, at);
          await events.finish(
            "stripe",
            id,
            outcome,
            { subject, occurredAt: null },
            true,
            attribution,
          );
        };
        await record(
          "evt_a",
          "2026-10-21T08:00:00.000Z",
          "amount_rejected",
          "payment:pi_a",
          {
            workspaceId: "ws-1",
            intentId: "intent-1",
          },
        );
        await record(
          "evt_b",
          "2026-10-21T09:00:00.000Z",
          "intent_unresolved",
          "refund:re_b",
        );
        await record(
          "evt_c",
          "2026-10-21T10:00:00.000Z",
          "amount_rejected",
          "payment:pi_c",
          {
            workspaceId: "ws-2",
            intentId: "intent-2",
          },
        );
        await events.claim("stripe", "evt_ok", "2026-10-21T11:00:00.000Z");
        await events.finish("stripe", "evt_ok", "applied", {
          subject: null,
          occurredAt: null,
        });
        return { db, events };
      }

      // #603-T01
      it("lists the open reviews newest first with the outcome, the subject and, where known, the workspace and the intent", async () => {
        const { events } = await withReviews();

        const page = await events.listReviews({
          state: "open",
          limit: 10,
          offset: 0,
        });

        expect(page.map((row) => row.eventId)).toEqual([
          "evt_c",
          "evt_b",
          "evt_a",
        ]);
        expect(page[0]).toEqual({
          provider: "stripe",
          eventId: "evt_c",
          outcome: "amount_rejected",
          subject: "payment:pi_c",
          workspaceId: "ws-2",
          intentId: "intent-2",
          receivedAt: "2026-10-21T10:00:00.000Z",
          reviewState: "open",
          resolution: null,
        });
      });

      // #603-T04
      it("lists a review of a payment that is none of ours without a workspace and an intent", async () => {
        const { events } = await withReviews();

        const page = await events.listReviews({
          state: "open",
          limit: 10,
          offset: 0,
        });

        expect(page.find((row) => row.eventId === "evt_b")).toMatchObject({
          subject: "refund:re_b",
          workspaceId: null,
          intentId: null,
        });
      });

      // #603-T07
      it("pages the list and counts the reviews of each state", async () => {
        const { events } = await withReviews();

        const first = await events.listReviews({
          state: "open",
          limit: 2,
          offset: 0,
        });
        const second = await events.listReviews({
          state: "open",
          limit: 2,
          offset: 2,
        });

        expect(first.map((row) => row.eventId)).toEqual(["evt_c", "evt_b"]);
        expect(second.map((row) => row.eventId)).toEqual(["evt_a"]);
        expect(await events.countReviews("open")).toBe(3);
        expect(await events.countReviews("resolved")).toBe(0);
      });

      // #603-T02
      it("keeps who closed a review, when, why and with which entry, and a second close changes nothing", async () => {
        const { events } = await withReviews();
        const resolution = {
          resolvedBy: "user-1",
          note: "credited by hand",
          entryId: "entry-1",
          at: "2026-10-21T12:00:00.000Z",
        };

        const first = await events.resolveReview("stripe", "evt_a", resolution);
        const second = await events.resolveReview("stripe", "evt_a", {
          ...resolution,
          resolvedBy: "user-2",
          note: "again",
          entryId: null,
        });

        expect(first).toBe(true);
        expect(second).toBe(false);
        const closed = await events.listReviews({
          state: "resolved",
          limit: 10,
          offset: 0,
        });
        expect(closed).toEqual([
          expect.objectContaining({
            eventId: "evt_a",
            outcome: "amount_rejected",
            reviewState: "resolved",
            resolution,
          }),
        ]);
        expect(await events.countReviews("open")).toBe(2);
        expect(await events.getReview("stripe", "evt_a")).toMatchObject({
          resolution,
        });
      });

      // #603-T02
      it("reads one review by its provider and event id, open or resolved, and nothing for an event that was not under review", async () => {
        const { events } = await withReviews();

        expect(await events.getReview("stripe", "evt_b")).toMatchObject({
          eventId: "evt_b",
          reviewState: "open",
        });
        expect(await events.getReview("stripe", "evt_ok")).toBeUndefined();
        expect(await events.getReview("other", "evt_b")).toBeUndefined();
      });

      // #603-T02
      it("starts a redelivered event over without the resolution of the earlier review", async () => {
        const { events } = await withReviews();
        await events.resolveReview("stripe", "evt_b", {
          resolvedBy: "user-1",
          note: "nothing to do",
          entryId: null,
          at: "2026-10-21T12:00:00.000Z",
        });

        const again = await events.claim(
          "stripe",
          "evt_b",
          "2026-10-21T13:00:00.000Z",
        );

        expect(again).toEqual({ claimed: true });
        expect(await events.getReview("stripe", "evt_b")).toBeUndefined();
      });
    },
  );
}

for (const engine of BILLING_ENGINES) suite(engine);
