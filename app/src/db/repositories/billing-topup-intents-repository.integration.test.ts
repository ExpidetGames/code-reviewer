// SPDX-License-Identifier: Apache-2.0

// #497: the top-up intents (a repository of one workspace), the directory that finds an intent before the workspace is
// known, and the record of provider events, on SQLite and on Postgres.
import { describe, expect, it } from "vitest";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../../test-support/billing-engines.ts";
import { TopUpIntentError } from "../../billing/topup-intent.ts";
import { createBillingTopUpIntentDirectory } from "./billing-topup-intent-directory-repository.ts";
import { createBillingTopUpIntentsRepository } from "./billing-topup-intents-repository.ts";
import { createBillingWebhookEventsRepository } from "./billing-webhook-events-repository.ts";

const USD = 1_000_000;

async function codeOf(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    return error instanceof TopUpIntentError ? error.code : "other";
  }
  return undefined;
}

function suite(engine: BillingEngine) {
  describe.skipIf(engine.skip)(`top-up intents on ${engine.name}`, () => {
    // #497-T03
    it("writes a pending intent for the amount that was asked for", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);

      const intent = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });

      expect(intent).toMatchObject({
        workspaceId,
        adapter: "fake",
        amountMicroUsd: 25 * USD,
        state: "pending",
        checkoutRef: null,
        paymentRef: null,
      });
      expect(await intents.get(intent.id)).toEqual(intent);
      expect((await intents.list({ limit: 10 })).map((i) => i.id)).toEqual([
        intent.id,
      ]);
    });

    // #501-T06
    it("writes an intent under the id the caller chose, once: a second with that id is refused and nothing changes", async () => {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const others = createBillingTopUpIntentsRepository(db, otherWorkspaceId);
      const id = "6f1f4a2e-0c52-4b8e-9a43-0d0f6f1d2a11";

      const first = await intents.create({
        id,
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });

      expect(first.id).toBe(id);
      await expect(
        intents.create({ id, adapter: "fake", amountMicroUsd: 30 * USD }),
      ).rejects.toThrow();
      await expect(
        others.create({ id, adapter: "fake", amountMicroUsd: 30 * USD }),
      ).rejects.toThrow();
      expect(await intents.get(id)).toEqual(first);
      expect(await others.get(id)).toBeUndefined();
    });

    // #497-T03
    it("refuses an amount outside 10 to 500 USD, a fraction and an adapter id that is not one", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);

      for (const amountMicroUsd of [
        9_999_999,
        500 * USD + 1,
        0,
        -1,
        25.5 * USD + 0.5,
      ])
        expect(
          await codeOf(intents.create({ adapter: "fake", amountMicroUsd })),
          String(amountMicroUsd),
        ).toBe("amount_out_of_range");
      expect(
        await codeOf(
          intents.create({ adapter: "No Id", amountMicroUsd: 25 * USD }),
        ),
      ).toBe("adapter_invalid");
      expect(await intents.list({ limit: 10 })).toEqual([]);
    });

    // #497-T03
    it("records the provider ids once and keeps them", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const intent = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });

      const attached = await intents.attachRefs(intent.id, {
        checkoutRef: "cs_1",
      });
      expect(attached?.intent.checkoutRef).toBe("cs_1");
      // The same value again changes nothing; another value is refused.
      expect(
        (await intents.attachRefs(intent.id, { checkoutRef: "cs_1" }))?.intent
          .checkoutRef,
      ).toBe("cs_1");
      expect(
        await codeOf(intents.attachRefs(intent.id, { checkoutRef: "cs_2" })),
      ).toBe("ref_conflict");
      expect(
        (await intents.attachRefs(intent.id, { paymentRef: "pi_1" }))?.intent
          .paymentRef,
      ).toBe("pi_1");
      expect(
        await intents.attachRefs("missing", { paymentRef: "pi_9" }),
      ).toBeUndefined();
      // A reference is an opaque id, not data.
      expect(
        await codeOf(intents.attachRefs(intent.id, { paymentRef: "a b@c" })),
      ).toBe("ref_invalid");
    });

    // #497-T03
    it("marks an intent paid once, failed only while pending, and never moves paid back", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const failing = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      const paying = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });

      expect((await intents.markFailed(failing.id))?.changed).toBe(true);
      expect((await intents.markFailed(failing.id))?.changed).toBe(false);
      // A payment that arrives after an asynchronous failure still pays the intent.
      const paidAfterFailure = await intents.markPaid(failing.id, {
        paymentRef: "pi_f",
        checkoutRef: "cs_f",
        creditedMicroUsd: 25 * USD,
      });
      expect(paidAfterFailure).toMatchObject({
        changed: true,
        intent: { state: "paid", paymentRef: "pi_f", checkoutRef: "cs_f" },
      });

      const paid = await intents.markPaid(paying.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 25 * USD,
      });
      expect(paid).toMatchObject({
        changed: true,
        intent: { state: "paid", paymentRef: "pi_1" },
      });
      expect(
        (
          await intents.markPaid(paying.id, {
            paymentRef: "pi_1",
            creditedMicroUsd: 25 * USD,
          })
        )?.changed,
      ).toBe(false);
      expect(
        await codeOf(
          intents.markPaid(paying.id, {
            paymentRef: "pi_2",
            creditedMicroUsd: 25 * USD,
          }),
        ),
      ).toBe("ref_conflict");
      expect((await intents.markFailed(paying.id))?.changed).toBe(false);
      expect((await intents.get(paying.id))?.state).toBe("paid");
      expect(
        await intents.markPaid("missing", {
          paymentRef: "pi_3",
          creditedMicroUsd: 25 * USD,
        }),
      ).toBeUndefined();
    });

    // #497-T03
    it("records what the payment credited, and never changes it once paid", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const intent = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      expect(intent).toMatchObject({
        creditedMicroUsd: 0,
        refundedMicroUsd: 0,
        disputedMicroUsd: 0,
      });

      await intents.markPaid(intent.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 20 * USD,
      });
      const again = await intents.markPaid(intent.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 25 * USD,
      });

      expect(again?.changed).toBe(false);
      expect((await intents.get(intent.id))?.creditedMicroUsd).toBe(20 * USD);
    });

    // #502-T08
    it("pins what the buyer was charged when the payment is credited: once, never changed, and a bad amount is refused", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const intent = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      expect(intent.providerAmount).toBeNull();

      for (const providerAmount of [0, -5, 1.5, Number.NaN])
        expect(
          await codeOf(
            intents.markPaid(intent.id, {
              paymentRef: "pi_1",
              creditedMicroUsd: 25 * USD,
              providerAmount,
            }),
          ),
          String(providerAmount),
        ).toBe("amount_out_of_range");
      expect((await intents.get(intent.id))?.state).toBe("pending");

      await intents.markPaid(intent.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 25 * USD,
        providerAmount: 2975,
      });
      const again = await intents.markPaid(intent.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 25 * USD,
        providerAmount: 5000,
      });

      expect(again?.changed).toBe(false);
      expect((await intents.get(intent.id))?.providerAmount).toBe(2975);
    });

    // #502-T08
    it("pins the amount of a payment that was credited without one when it is told later, and leaves an unpinned intent unpinned otherwise", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const intent = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      await intents.markPaid(intent.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 25 * USD,
      });
      expect((await intents.get(intent.id))?.providerAmount).toBeNull();

      const late = await intents.markPaid(intent.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 25 * USD,
        providerAmount: 2975,
      });

      expect(late?.changed).toBe(true);
      expect((await intents.get(intent.id))?.providerAmount).toBe(2975);
    });

    // #497-T07
    it("keeps running totals of what refunds and disputes debited, inside what the payment credited", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const intent = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      await intents.markPaid(intent.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 25 * USD,
      });

      await intents.addDebited(intent.id, "refund", 20 * USD);
      await intents.addDebited(intent.id, "dispute", 5 * USD);
      expect(await intents.get(intent.id)).toMatchObject({
        refundedMicroUsd: 20 * USD,
        disputedMicroUsd: 5 * USD,
      });
      // Together they stay inside the credit, and a total never goes below zero.
      expect(await codeOf(intents.addDebited(intent.id, "refund", 1))).toBe(
        "debit_out_of_bounds",
      );
      expect(
        await codeOf(intents.addDebited(intent.id, "dispute", -6 * USD)),
      ).toBe("debit_out_of_bounds");
      await intents.addDebited(intent.id, "refund", -20 * USD);
      expect((await intents.get(intent.id))?.refundedMicroUsd).toBe(0);
      expect(await intents.addDebited("missing", "refund", 1)).toBeUndefined();
    });

    // #497-T07
    it("refuses in the database a total above the credit, so no code path can over-debit", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const intent = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      await intents.markPaid(intent.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 25 * USD,
      });

      await db
        .updateTable("billing_topup_intents")
        .set({ refunded_micro_usd: 20 * USD, disputed_micro_usd: 5 * USD })
        .where("id", "=", intent.id)
        .execute();
      await expect(
        db
          .updateTable("billing_topup_intents")
          .set({ refunded_micro_usd: 20 * USD, disputed_micro_usd: 6 * USD })
          .where("id", "=", intent.id)
          .execute(),
      ).rejects.toThrow();
      await expect(
        db
          .updateTable("billing_topup_intents")
          .set({ refunded_micro_usd: -1 })
          .where("id", "=", intent.id)
          .execute(),
      ).rejects.toThrow();
    });

    // #501-T18
    it("fails the pending intents without a page that are old enough, in this workspace only, and leaves the others", async () => {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      const at = (minutes: number) => () =>
        new Date(Date.UTC(2026, 9, 21, 10, minutes));
      const old = createBillingTopUpIntentsRepository(db, workspaceId, at(0));
      const others = createBillingTopUpIntentsRepository(
        db,
        otherWorkspaceId,
        at(0),
      );
      const stale = await old.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      const paged = await old.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      await old.attachRefs(paged.id, { checkoutRef: "cs_1" });
      const paid = await old.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      await old.markPaid(paid.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 25 * USD,
      });
      const foreign = await others.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      const fresh = await createBillingTopUpIntentsRepository(
        db,
        workspaceId,
        at(25),
      ).create({ adapter: "fake", amountMicroUsd: 25 * USD });
      const sweeper = createBillingTopUpIntentsRepository(
        db,
        workspaceId,
        at(30),
      );

      expect(await sweeper.failPendingWithoutPage(30 * 60_000)).toBe(1);
      expect(await sweeper.failPendingWithoutPage(30 * 60_000)).toBe(0);

      const state = async (id: string) => (await old.get(id))!.state;
      expect(await state(stale.id)).toBe("failed");
      expect(await state(paged.id)).toBe("pending");
      expect(await state(paid.id)).toBe("paid");
      expect(await state(fresh.id)).toBe("pending");
      expect((await others.get(foreign.id))!.state).toBe("pending");
    });

    // #497-T03
    it("expires a pending intent only, and a payment can still pay an expired one", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const pending = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      const paid = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      await intents.markPaid(paid.id, {
        paymentRef: "pi_p",
        creditedMicroUsd: 25 * USD,
      });

      expect((await intents.markExpired(pending.id))?.changed).toBe(true);
      expect((await intents.markExpired(pending.id))?.changed).toBe(false);
      expect((await intents.markExpired(paid.id))?.changed).toBe(false);
      expect((await intents.get(paid.id))?.state).toBe("paid");
      expect(await intents.markExpired("missing")).toBeUndefined();
      const late = await intents.markPaid(pending.id, {
        paymentRef: "pi_late",
        creditedMicroUsd: 25 * USD,
      });
      expect(late?.intent.state).toBe("paid");
    });

    // #497-T03
    it("does not let a second intent take a payment that belongs to another", async () => {
      const { db, workspaceId } = await engine.create();
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const first = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      const second = await intents.create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      await intents.markPaid(first.id, {
        paymentRef: "pi_1",
        creditedMicroUsd: 25 * USD,
      });

      expect(
        await codeOf(
          intents.markPaid(second.id, {
            paymentRef: "pi_1",
            creditedMicroUsd: 25 * USD,
          }),
        ),
      ).toBe("ref_conflict");
      expect((await intents.get(second.id))?.state).toBe("pending");
    });

    // #497-T09
    it("finds an intent by id, payment or checkout across workspaces, only for the adapter that made it", async () => {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      const mine = await createBillingTopUpIntentsRepository(
        db,
        workspaceId,
      ).create({ adapter: "fake", amountMicroUsd: 25 * USD });
      const other = await createBillingTopUpIntentsRepository(
        db,
        otherWorkspaceId,
      ).create({ adapter: "fake", amountMicroUsd: 50 * USD });
      await createBillingTopUpIntentsRepository(db, workspaceId).attachRefs(
        mine.id,
        { checkoutRef: "cs_1", paymentRef: "pi_1" },
      );
      const directory = createBillingTopUpIntentDirectory(db);

      expect((await directory.findById("fake", mine.id))?.workspaceId).toBe(
        workspaceId,
      );
      expect((await directory.findById("fake", other.id))?.workspaceId).toBe(
        otherWorkspaceId,
      );
      expect((await directory.findByPayment("fake", "pi_1"))?.id).toBe(mine.id);
      expect((await directory.findByCheckout("fake", "cs_1"))?.id).toBe(
        mine.id,
      );
      expect(await directory.findById("stripe", mine.id)).toBeUndefined();
      expect(await directory.findByPayment("stripe", "pi_1")).toBeUndefined();
      expect(await directory.findById("fake", "missing")).toBeUndefined();
      expect((await directory.lockById(mine.id))?.id).toBe(mine.id);
      expect(await directory.lockById("missing")).toBeUndefined();
    });
  });

  describe.skipIf(engine.skip)(`webhook events on ${engine.name}`, () => {
    const AT = "2026-10-19T08:00:00.000Z";

    // #497-T04
    it("lets one request claim an event id and answers a repeat with the outcome", async () => {
      const { db } = await engine.create();

      const first = await db.transaction().execute(async (trx) => {
        const events = createBillingWebhookEventsRepository(trx);
        const claim = await events.claim("fake", "evt_1", AT);
        await events.finish("fake", "evt_1", "applied", {
          subject: null,
          occurredAt: null,
        });
        return claim;
      });
      const second = await createBillingWebhookEventsRepository(db).claim(
        "fake",
        "evt_1",
        AT,
      );

      expect(first).toEqual({ claimed: true });
      expect(second).toEqual({ claimed: false, outcome: "applied" });
      expect(
        await createBillingWebhookEventsRepository(db).claim(
          "other",
          "evt_1",
          AT,
        ),
      ).toEqual({ claimed: true });
    });

    // #497-T04
    it("lets exactly one of many concurrent requests claim the same event id", async () => {
      const { db } = await engine.create();

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          db.transaction().execute(async (trx) => {
            const events = createBillingWebhookEventsRepository(trx);
            const claim = await events.claim("fake", "evt_race", AT);
            if (claim.claimed)
              await events.finish("fake", "evt_race", "applied", {
                subject: null,
                occurredAt: null,
              });
            return claim;
          }),
        ),
      );

      expect(results.filter((result) => result.claimed)).toHaveLength(1);
      expect(
        results
          .filter((result) => !result.claimed)
          .every((result) => !result.claimed && result.outcome === "applied"),
      ).toBe(true);
    });

    // #497-T09
    it("lets an event whose intent was unknown be claimed again on redelivery", async () => {
      const { db } = await engine.create();
      const events = createBillingWebhookEventsRepository(db);
      await events.claim("fake", "evt_u", AT);
      await events.finish("fake", "evt_u", "intent_unresolved", {
        subject: null,
        occurredAt: null,
      });

      expect(await events.claim("fake", "evt_u", AT)).toEqual({
        claimed: true,
      });
      await events.finish("fake", "evt_u", "applied", {
        subject: null,
        occurredAt: null,
      });
      expect(await events.claim("fake", "evt_u", AT)).toEqual({
        claimed: false,
        outcome: "applied",
      });
    });

    // #497-T09
    // #502-T19
    it("lists the events flagged for review, oldest first, with whose payment each is when it was attributed, and leaves the others out", async () => {
      const { db } = await engine.create();
      const events = createBillingWebhookEventsRepository(db);
      const record = async (
        id: string,
        outcome: "applied" | "amount_rejected" | "intent_unresolved",
        review: boolean,
        receivedAt: string,
        attribution?: { workspaceId: string; intentId: string },
      ) => {
        await events.claim("fake", id, receivedAt);
        await events.finish(
          "fake",
          id,
          outcome,
          { subject: `payment:pi_${id}`, occurredAt: null },
          review,
          attribution,
        );
      };
      await record(
        "late",
        "intent_unresolved",
        true,
        "2026-10-19T10:00:00.000Z",
      );
      await record("fine", "applied", false, "2026-10-19T09:00:00.000Z");
      await record(
        "early",
        "amount_rejected",
        true,
        "2026-10-19T08:00:00.000Z",
        { workspaceId: "w-early", intentId: "i-early" },
      );

      const open = await events.listOpenReviews({ limit: 10 });

      expect(open).toEqual([
        {
          provider: "fake",
          eventId: "early",
          outcome: "amount_rejected",
          subject: "payment:pi_early",
          workspaceId: "w-early",
          intentId: "i-early",
          receivedAt: "2026-10-19T08:00:00.000Z",
        },
        {
          provider: "fake",
          eventId: "late",
          outcome: "intent_unresolved",
          subject: "payment:pi_late",
          workspaceId: null,
          intentId: null,
          receivedAt: "2026-10-19T10:00:00.000Z",
        },
      ]);
      expect(await events.listOpenReviews({ limit: 1 })).toHaveLength(1);
    });

    // #497-T06
    it("tells whether a newer state of the same refund or dispute was applied", async () => {
      const { db } = await engine.create();
      const events = createBillingWebhookEventsRepository(db);
      const record = async (
        id: string,
        subject: string,
        occurredAt: string,
        outcome: "applied" | "stale_ignored" | "nothing_to_reverse",
      ) => {
        await events.claim("fake", id, AT);
        await events.finish("fake", id, outcome, { subject, occurredAt });
      };
      await record("e1", "refund:re_1", "2026-10-19T09:00:00.000Z", "applied");
      await record(
        "e2",
        "refund:re_2",
        "2026-10-19T12:00:00.000Z",
        "stale_ignored",
      );
      await record(
        "e3",
        "dispute:dp_1",
        "2026-10-19T10:00:00.000Z",
        "nothing_to_reverse",
      );

      const newer = (subject: string, at: string) =>
        events.hasNewerState("fake", subject, at);
      expect(await newer("refund:re_1", "2026-10-19T08:00:00.000Z")).toBe(true);
      expect(await newer("refund:re_1", "2026-10-19T09:00:00.000Z")).toBe(
        false,
      );
      expect(await newer("refund:re_1", "2026-10-19T09:00:00.001Z")).toBe(
        false,
      );
      // An event that was itself ignored as stale is not a state.
      expect(await newer("refund:re_2", "2026-10-19T08:00:00.000Z")).toBe(
        false,
      );
      expect(await newer("dispute:dp_1", "2026-10-19T09:00:00.000Z")).toBe(
        true,
      );
      expect(await newer("refund:other", "2026-10-19T01:00:00.000Z")).toBe(
        false,
      );
    });
  });
}

for (const engine of BILLING_ENGINES) suite(engine);
