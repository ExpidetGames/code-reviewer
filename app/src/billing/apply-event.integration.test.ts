// SPDX-License-Identifier: Apache-2.0

// #497: the generic application of normalized billing events to the journal, on SQLite and on Postgres. An adapter only
// reads a provider; this layer decides what an event does: one transaction per event, idempotent per event id and per
// payment, ordered per refund or dispute, mapped to a workspace only through the top-up intent the app wrote.
import type { Kysely, KyselyPlugin } from "kysely";
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createBillingWebhookEventsRepository } from "../db/repositories/billing-webhook-events-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../test-support/billing-engines.ts";
import { toProviderAmount, toUsd, type BillingEvent } from "./adapter.ts";
import { applyBillingEvent } from "./apply-event.ts";

const USD = 1_000_000;
const PROVIDER = "fake";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

const at = (minutes: number) =>
  new Date(
    Date.parse("2026-10-19T08:00:00.000Z") + minutes * 60_000,
  ).toISOString();

type Seeded = {
  db: Kysely<Database>;
  workspaceId: string;
  otherWorkspaceId: string;
  intentId: string;
  payment: string;
  checkout: string;
};

async function seed(engine: BillingEngine, amount = 25 * USD): Promise<Seeded> {
  const { db, workspaceId, otherWorkspaceId } = await engine.create();
  const intent = await createBillingTopUpIntentsRepository(
    db,
    workspaceId,
  ).create({
    adapter: PROVIDER,
    amountMicroUsd: amount,
  });
  return {
    db,
    workspaceId,
    otherWorkspaceId,
    intentId: intent.id,
    payment: nextId("pi"),
    checkout: nextId("cs"),
  };
}

function succeeded(
  s: Seeded,
  overrides: Partial<Extract<BillingEvent, { type: "payment.succeeded" }>> = {},
): BillingEvent {
  return {
    type: "payment.succeeded",
    eventId: nextId("evt"),
    occurredAt: at(0),
    intentId: s.intentId,
    payment: s.payment,
    checkout: s.checkout,
    creditable: toUsd(25 * USD),
    gross: toUsd(29_750_000),
    tax: toUsd(4_750_000),
    ...overrides,
  };
}

function refund(
  s: Seeded,
  overrides: Partial<Extract<BillingEvent, { type: "refund.updated" }>> = {},
): BillingEvent {
  return {
    type: "refund.updated",
    eventId: nextId("evt"),
    occurredAt: at(10),
    payment: s.payment,
    refund: "re_1",
    amount: toProviderAmount(5 * USD),
    paymentAmount: toProviderAmount(25 * USD),
    initiatedBy: "provider",
    status: "approved",
    ...overrides,
  };
}

function dispute(
  s: Seeded,
  overrides: Partial<Extract<BillingEvent, { type: "dispute.updated" }>> = {},
): BillingEvent {
  return {
    type: "dispute.updated",
    eventId: nextId("evt"),
    occurredAt: at(10),
    payment: s.payment,
    dispute: "dp_1",
    amount: toProviderAmount(25 * USD),
    paymentAmount: toProviderAmount(25 * USD),
    status: "lost",
    ...overrides,
  };
}

const apply = (s: Seeded, event: BillingEvent) =>
  applyBillingEvent(s.db, { provider: PROVIDER, event });

async function entries(s: Seeded, workspaceId = s.workspaceId) {
  return (
    await createBillingJournalRepository(s.db, workspaceId).entries({
      limit: 100,
    })
  ).entries;
}
async function balance(s: Seeded, workspaceId = s.workspaceId) {
  return (await createBillingJournalRepository(s.db, workspaceId).balance())
    .balanceMicroUsd;
}
async function intentOf(s: Seeded) {
  return createBillingTopUpIntentsRepository(s.db, s.workspaceId).get(
    s.intentId,
  );
}

/** Fails the first statement that changes `table`, to test that nothing of an event stays when one step fails. */
function failingOn(table: string, armed: { on: boolean }): KyselyPlugin {
  return {
    transformQuery({ node }) {
      const text = JSON.stringify(node);
      if (
        armed.on &&
        node.kind === "UpdateQueryNode" &&
        text.includes(`"${table}"`)
      )
        throw new Error("injected database failure");
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

function suite(engine: BillingEngine) {
  describe.skipIf(engine.skip)(
    `applying billing events on ${engine.name}`,
    () => {
      // #497-T03
      it("turns a successful payment of a known intent into a top-up for its workspace", async () => {
        const s = await seed(engine);

        const result = await apply(s, succeeded(s));

        expect(result).toMatchObject({
          outcome: "applied",
          workspaceId: s.workspaceId,
        });
        expect(await entries(s)).toMatchObject([
          {
            type: "top_up",
            amountMicroUsd: 25 * USD,
            refKey: s.payment,
            provider: PROVIDER,
            providerRef: s.payment,
          },
        ]);
        expect(await balance(s)).toBe(25 * USD);
        expect(await intentOf(s)).toMatchObject({
          state: "paid",
          paymentRef: s.payment,
          checkoutRef: s.checkout,
        });
        expect(await entries(s, s.otherWorkspaceId)).toEqual([]);
      });

      // #497-T03
      it("credits the net amount the intent asked for and never the gross amount", async () => {
        const s = await seed(engine);

        await apply(
          s,
          succeeded(s, {
            creditable: toUsd(25 * USD),
            gross: toUsd(30 * USD),
            tax: toUsd(5 * USD),
          }),
        );

        expect(await balance(s)).toBe(25 * USD);
      });

      // #497-T03
      // #502-T17: the credit is EXACTLY the amount we asked for; a smaller net (a discount) is not the top-up the buyer started.
      it("refuses a credit that is not the amount we asked for (above, below, under the minimum), and credits nothing", async () => {
        const s = await seed(engine);

        for (const creditable of [
          25 * USD + 1,
          25 * USD - 1,
          22_500_000,
          400 * USD,
          9 * USD,
        ]) {
          const result = await apply(
            s,
            succeeded(s, { creditable: toUsd(creditable) }),
          );
          expect(result.outcome, String(creditable)).toBe("amount_rejected");
        }

        expect(await entries(s)).toEqual([]);
        expect(await intentOf(s)).toMatchObject({
          state: "pending",
          paymentRef: null,
        });
      });

      // #497-T03
      it("finds the intent by the checkout it recorded, by the payment it recorded, or by our own reference", async () => {
        const byCheckout = await seed(engine);
        await createBillingTopUpIntentsRepository(
          byCheckout.db,
          byCheckout.workspaceId,
        ).attachRefs(byCheckout.intentId, { checkoutRef: byCheckout.checkout });
        expect(
          (await apply(byCheckout, succeeded(byCheckout, { intentId: null })))
            .outcome,
        ).toBe("applied");

        const byPayment = await seed(engine);
        await createBillingTopUpIntentsRepository(
          byPayment.db,
          byPayment.workspaceId,
        ).attachRefs(byPayment.intentId, { paymentRef: byPayment.payment });
        expect(
          (
            await apply(
              byPayment,
              succeeded(byPayment, { intentId: null, checkout: null }),
            )
          ).outcome,
        ).toBe("applied");

        const byReference = await seed(engine);
        expect(
          (await apply(byReference, succeeded(byReference, { checkout: null })))
            .outcome,
        ).toBe("applied");
      });

      // #497-T09
      it("leaves an event alone whose intent is not ours: unknown, of another adapter, or contradicting what is recorded", async () => {
        const s = await seed(engine);
        const other = await seed(engine);
        await createBillingTopUpIntentsRepository(
          other.db,
          other.workspaceId,
        ).attachRefs(other.intentId, { paymentRef: "pi_recorded" });

        const unknown = await apply(
          s,
          succeeded(s, { intentId: "no-such-intent" }),
        );
        const nothing = await apply(
          s,
          succeeded(s, { intentId: null, checkout: null }),
        );
        const otherAdapter = await applyBillingEvent(s.db, {
          provider: "stripe",
          event: succeeded(s),
        });
        // The payment is recorded on one intent while the event names another: nothing is credited to either.
        const contradicting = await apply(
          other,
          succeeded(other, { payment: "pi_recorded", intentId: s.intentId }),
        );

        expect(unknown).toEqual({
          outcome: "intent_unresolved",
          workspaceId: null,
          needsReview: true,
        });
        expect(nothing.outcome).toBe("intent_unresolved");
        expect(otherAdapter.outcome).toBe("intent_unresolved");
        expect(contradicting.outcome).toBe("intent_unresolved");
        expect(await entries(s)).toEqual([]);
        expect(await entries(other)).toEqual([]);
      });

      // #497-T09
      it("never credits a second payment to an intent that has been paid", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const second = await apply(
          s,
          succeeded(s, { payment: nextId("pi"), checkout: null }),
        );

        expect(second.outcome).toBe("intent_unresolved");
        expect(await balance(s)).toBe(25 * USD);
      });

      // #497-T04
      it("applies the same event twice once, and answers the repeat as a duplicate", async () => {
        const s = await seed(engine);
        const event = succeeded(s);

        const first = await apply(s, event);
        const second = await apply(s, event);

        expect(first.outcome).toBe("applied");
        expect(second.outcome).toBe("duplicate_ignored");
        expect(await entries(s)).toHaveLength(1);
        expect(await balance(s)).toBe(25 * USD);
      });

      // #497-T04
      it("applies the same event once when it arrives many times at the same moment", async () => {
        const s = await seed(engine);
        const event = succeeded(s);

        const results = await Promise.all(
          Array.from({ length: 8 }, () => apply(s, event)),
        );

        expect(
          results.filter((result) => result.outcome === "applied"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.outcome === "duplicate_ignored"),
        ).toHaveLength(7);
        expect(await entries(s)).toHaveLength(1);
        expect(await balance(s)).toBe(25 * USD);
        expect(
          (await createBillingJournalRepository(s.db, s.workspaceId).verify())
            .consistent,
        ).toBe(true);
      });

      // #497-T05
      it("credits one payment once whatever the event ids, also at the same moment", async () => {
        const s = await seed(engine);

        const results = await Promise.all(
          Array.from({ length: 6 }, () => apply(s, succeeded(s))),
        );

        expect(
          results.filter((result) => result.outcome === "applied"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.outcome === "duplicate_ignored"),
        ).toHaveLength(5);
        expect(await entries(s)).toHaveLength(1);
        expect(await balance(s)).toBe(25 * USD);
      });

      // #497-T05
      // #502-T17: another net amount than the intent asked for is refused before the journal is asked (it was a conflict of the key).
      it("answers a payment that arrives again with another amount without changing the credit", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const again = await apply(
          s,
          succeeded(s, { creditable: toUsd(20 * USD) }),
        );

        expect(again.outcome).toBe("amount_rejected");
        expect(await balance(s)).toBe(25 * USD);
      });

      // #497-T06
      it("records a refund older than the last applied state of that refund as stale and writes nothing", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));
        const approved = await apply(
          s,
          refund(s, { occurredAt: at(20), status: "approved" }),
        );

        const older = await apply(
          s,
          refund(s, {
            occurredAt: at(10),
            status: "pending",
            amount: toProviderAmount(7 * USD),
          }),
        );

        expect(approved.outcome).toBe("applied");
        expect(older.outcome).toBe("stale_ignored");
        expect(
          (await entries(s)).filter((entry) => entry.type === "refund"),
        ).toMatchObject([{ amountMicroUsd: -5 * USD, refKey: "re_1" }]);
        expect(await balance(s)).toBe(20 * USD);
        // The stale event is final: its id is a duplicate when it comes again.
        const event = refund(s, { occurredAt: at(5) });
        expect((await apply(s, event)).outcome).toBe("stale_ignored");
        expect((await apply(s, event)).outcome).toBe("duplicate_ignored");
      });

      // #497-T06
      it("treats the states of one refund in order whatever the order of arrival", async () => {
        const inOrder = await seed(engine);
        await apply(inOrder, succeeded(inOrder));
        await apply(
          inOrder,
          refund(inOrder, { occurredAt: at(10), status: "pending" }),
        );
        await apply(
          inOrder,
          refund(inOrder, { occurredAt: at(20), status: "rejected" }),
        );

        const reordered = await seed(engine);
        await apply(reordered, succeeded(reordered));
        await apply(
          reordered,
          refund(reordered, { occurredAt: at(20), status: "rejected" }),
        );
        await apply(
          reordered,
          refund(reordered, { occurredAt: at(10), status: "pending" }),
        );

        // Debited and given back in order; or rejected first (nothing to give back) and the older pending state ignored.
        expect(await balance(inOrder)).toBe(25 * USD);
        expect(await balance(reordered)).toBe(25 * USD);
        expect(
          (await entries(inOrder)).map((entry) => entry.type).sort(),
        ).toEqual(["correction", "refund", "top_up"]);
        expect((await entries(reordered)).map((entry) => entry.type)).toEqual([
          "top_up",
        ]);
      });

      // #497-T07
      it("debits a refund beyond the unspent balance and lets the balance go negative", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));
        const journal = createBillingJournalRepository(s.db, s.workspaceId);
        await journal.reserve(20 * USD, "job-1");
        await journal.settle("job-1", {
          aiMicroUsd: 0,
          infraMicroUsd: 20 * USD,
          minutes: 10,
          reviewKind: "diff",
        });
        expect(await balance(s)).toBe(5 * USD);

        const result = await apply(
          s,
          refund(s, {
            amount: toProviderAmount(25 * USD),
            initiatedBy: "provider",
          }),
        );

        expect(result.outcome).toBe("applied");
        expect(await balance(s)).toBe(-20 * USD);
        const reserve = await journal.reserve(1 * USD, "job-2");
        expect(reserve).toMatchObject({ ok: false, code: "balance_negative" });
      });

      // #497-T07
      it("refuses a refund or dispute larger than what the intent credited", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const tooMuch = await apply(
          s,
          refund(s, { amount: toProviderAmount(25 * USD + 1) }),
        );
        const tooMuchDispute = await apply(
          s,
          dispute(s, { amount: toProviderAmount(26 * USD) }),
        );

        expect(tooMuch.outcome).toBe("amount_rejected");
        expect(tooMuchDispute.outcome).toBe("amount_rejected");
        expect(await balance(s)).toBe(25 * USD);
      });

      // #497-T09
      // #502-T18: a refund whose payment is not credited yet is not final (the provider delivers it again after the credit);
      // one that belongs to nothing of ours is.
      it("asks for a redelivery of a refund whose payment is unknown or was never credited while a top-up is waiting, and records nothing", async () => {
        const s = await seed(engine);
        const retry = { code: "credit_pending" };

        await expect(
          apply(s, refund(s, { payment: "pi_unknown" })),
        ).rejects.toMatchObject(retry);
        await createBillingTopUpIntentsRepository(
          s.db,
          s.workspaceId,
        ).attachRefs(s.intentId, { paymentRef: s.payment });
        await expect(
          apply(s, refund(s, { refund: "re_2" })),
        ).rejects.toMatchObject(retry);

        expect(await entries(s)).toEqual([]);
        expect(
          await s.db.selectFrom("billing_webhook_events").selectAll().execute(),
        ).toEqual([]);
      });

      // #502-T18
      it("leaves a refund of a payment that is no top-up of ours alone, with a review, when no top-up is waiting", async () => {
        const s = await seed(engine);
        await createBillingTopUpIntentsRepository(
          s.db,
          s.workspaceId,
        ).markFailed(s.intentId);

        const unknown = await apply(s, refund(s, { payment: "pi_unknown" }));

        expect(unknown).toMatchObject({
          outcome: "intent_unresolved",
          needsReview: true,
          workspaceId: null,
        });
        expect(await entries(s)).toEqual([]);
      });

      // #497-T09
      it("applies a redelivered refund once its payment is known", async () => {
        const s = await seed(engine);
        const early = refund(s);
        await expect(apply(s, early)).rejects.toMatchObject({
          code: "credit_pending",
        });
        await apply(s, succeeded(s));

        expect((await apply(s, early)).outcome).toBe("applied");
        expect(await balance(s)).toBe(20 * USD);
      });

      // #497-T08
      it("books a lost dispute as a chargeback, reverses it once when it is won, and refuses a second reversal", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const lost = await apply(
          s,
          dispute(s, { occurredAt: at(10), status: "lost" }),
        );
        const won = await apply(
          s,
          dispute(s, { occurredAt: at(30), status: "won" }),
        );
        const wonAgain = await apply(
          s,
          dispute(s, { occurredAt: at(31), status: "won" }),
        );

        expect([lost.outcome, won.outcome, wonAgain.outcome]).toEqual([
          "applied",
          "applied",
          "duplicate_ignored",
        ]);
        const types = (await entries(s)).map((entry) => entry.type).sort();
        expect(types).toEqual(["chargeback", "correction", "top_up"]);
        const correction = (await entries(s)).find(
          (entry) => entry.type === "correction",
        );
        const chargeback = (await entries(s)).find(
          (entry) => entry.type === "chargeback",
        );
        expect(correction).toMatchObject({
          amountMicroUsd: 25 * USD,
          reversesEntryId: chargeback?.id,
          provider: PROVIDER,
        });
        expect(await balance(s)).toBe(25 * USD);
      });

      // #497-T08
      it("debits a dispute once whether it is seen opened, lost or both", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        await apply(s, dispute(s, { occurredAt: at(10), status: "opened" }));
        await apply(s, dispute(s, { occurredAt: at(20), status: "lost" }));

        expect(
          (await entries(s)).filter((entry) => entry.type === "chargeback"),
        ).toHaveLength(1);
        expect(await balance(s)).toBe(0);
      });

      // #497-T08
      it("writes nothing for a dispute that is won before the older event that opened it arrives", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const won = await apply(
          s,
          dispute(s, { occurredAt: at(30), status: "won" }),
        );
        const opened = await apply(
          s,
          dispute(s, { occurredAt: at(10), status: "opened" }),
        );

        expect(won.outcome).toBe("nothing_to_reverse");
        expect(opened.outcome).toBe("stale_ignored");
        expect(await balance(s)).toBe(25 * USD);
        expect((await entries(s)).map((entry) => entry.type)).toEqual([
          "top_up",
        ]);
      });

      // #497-T08
      it("applies reordered and duplicated refund and dispute events to the state of one correct delivery", async () => {
        const make = async () => {
          const s = await seed(engine);
          await apply(s, succeeded(s));
          return s;
        };
        const events = (s: Seeded): BillingEvent[] => [
          refund(s, {
            refund: "re_a",
            occurredAt: at(10),
            status: "pending",
            amount: toProviderAmount(4 * USD),
          }),
          refund(s, {
            refund: "re_a",
            occurredAt: at(20),
            status: "approved",
            amount: toProviderAmount(4 * USD),
          }),
          dispute(s, {
            dispute: "dp_a",
            occurredAt: at(12),
            status: "opened",
            amount: toProviderAmount(10 * USD),
          }),
          dispute(s, {
            dispute: "dp_a",
            occurredAt: at(40),
            status: "won",
            amount: toProviderAmount(10 * USD),
          }),
          refund(s, {
            refund: "re_b",
            occurredAt: at(15),
            status: "pending",
            amount: toProviderAmount(3 * USD),
          }),
          refund(s, {
            refund: "re_b",
            occurredAt: at(25),
            status: "rejected",
            amount: toProviderAmount(3 * USD),
          }),
        ];

        const ordered = await make();
        for (const event of events(ordered)) await apply(ordered, event);

        const shuffled = await make();
        const list = events(shuffled);
        for (const event of [
          list[5]!,
          list[3]!,
          list[1]!,
          list[4]!,
          list[0]!,
          list[2]!,
          list[1]!,
          list[3]!,
          list[5]!,
        ])
          await apply(shuffled, event);

        // 25 credit - 4 refunded; the 10 dispute and the 3 refund were given back.
        expect(await balance(ordered)).toBe(21 * USD);
        expect(await balance(shuffled)).toBe(21 * USD);
        // The entries differ (the shuffled run never debited what was given back), the money does not.
        expect(
          (
            await createBillingJournalRepository(
              shuffled.db,
              shuffled.workspaceId,
            ).verify()
          ).consistent,
        ).toBe(true);
      });

      // #497-T08
      it("applies the states of one dispute that race each other as the later state says", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));
        const lost = dispute(s, { occurredAt: at(10), status: "lost" });
        const won = dispute(s, { occurredAt: at(30), status: "won" });

        await Promise.all([apply(s, won), apply(s, lost)]);

        // Either the debit and its reversal, or the older state ignored: the balance is the same.
        expect(await balance(s)).toBe(25 * USD);
        expect(
          (await entries(s)).filter((entry) => entry.type === "correction")
            .length,
        ).toBeLessThanOrEqual(1);
      });

      // #497-T03
      it("marks the intent failed on a failed payment without a credit, and lets a later payment pay it", async () => {
        const s = await seed(engine);

        const failed = await apply(s, {
          type: "payment.failed",
          eventId: nextId("evt"),
          occurredAt: at(0),
          intentId: s.intentId,
          payment: null,
          checkout: s.checkout,
        });

        expect(failed.outcome).toBe("applied");
        expect(await intentOf(s)).toMatchObject({ state: "failed" });
        expect(await entries(s)).toEqual([]);

        await apply(s, succeeded(s));
        expect(await intentOf(s)).toMatchObject({ state: "paid" });
        expect(await balance(s)).toBe(25 * USD);

        // A failure that arrives after the payment changes nothing.
        const late = await apply(s, {
          type: "payment.failed",
          eventId: nextId("evt"),
          occurredAt: at(0),
          intentId: s.intentId,
          payment: null,
          checkout: s.checkout,
        });
        expect(late.outcome).toBe("duplicate_ignored");
        expect(await intentOf(s)).toMatchObject({ state: "paid" });
      });

      // #497-T09
      it("records an event of a type it does not use and does nothing", async () => {
        const s = await seed(engine);
        const event: BillingEvent = {
          type: "ignored",
          eventId: nextId("evt"),
          occurredAt: at(0),
        };

        expect((await apply(s, event)).outcome).toBe("ignored_type");
        expect((await apply(s, event)).outcome).toBe("duplicate_ignored");
        expect(await entries(s)).toEqual([]);
        expect(
          await createBillingWebhookEventsRepository(s.db).claim(
            PROVIDER,
            event.eventId,
            at(0),
          ),
        ).toEqual({ claimed: false, outcome: "ignored_type" });
      });

      // #497-T09
      it("records a signed event that is not a normalized event as event_invalid, flags it for review and does not throw", async () => {
        const s = await seed(engine);
        const event = succeeded(s, { creditable: 1.5 as never });

        const result = await apply(s, event);
        const repeat = await apply(s, event);

        expect(result).toMatchObject({
          outcome: "event_invalid",
          workspaceId: null,
          needsReview: true,
        });
        expect(repeat.outcome).toBe("duplicate_ignored");
        expect(await entries(s)).toEqual([]);
        expect(
          await createBillingWebhookEventsRepository(s.db).listOpenReviews({
            limit: 10,
          }),
        ).toMatchObject([
          {
            provider: PROVIDER,
            eventId: event.eventId,
            outcome: "event_invalid",
          },
        ]);
      });

      // #497-T09
      it("answers event_invalid without recording when even the event id is not an id", async () => {
        const s = await seed(engine);

        const result = await apply(s, succeeded(s, { eventId: "has space" }));

        expect(result).toMatchObject({
          outcome: "event_invalid",
          needsReview: true,
        });
        expect(
          await s.db.selectFrom("billing_webhook_events").selectAll().execute(),
        ).toEqual([]);
      });

      // #497-T09
      it("accepts a payment with no tax: zero is a real amount", async () => {
        const s = await seed(engine);

        const result = await apply(
          s,
          succeeded(s, { gross: toUsd(25 * USD), tax: toUsd(0) }),
        );

        expect(result.outcome).toBe("applied");
        expect(await balance(s)).toBe(25 * USD);
      });

      // #497-T10
      it("leaves nothing of an event when a step fails, and a redelivery applies it", async () => {
        const s = await seed(engine);
        const armed = { on: true };
        const failing = s.db.withPlugin(
          failingOn("billing_topup_intents", armed),
        );
        const event = succeeded(s);

        await expect(
          applyBillingEvent(failing, { provider: PROVIDER, event }),
        ).rejects.toThrow("injected database failure");

        expect(await entries(s)).toEqual([]);
        expect(await balance(s)).toBe(0);
        expect(await intentOf(s)).toMatchObject({
          state: "pending",
          paymentRef: null,
        });
        expect(
          await createBillingWebhookEventsRepository(s.db).claim(
            PROVIDER,
            event.eventId,
            at(0),
          ),
        ).toEqual({ claimed: true });

        armed.on = false;
        const redelivery = await applyBillingEvent(failing, {
          provider: PROVIDER,
          event,
        });
        expect(redelivery.outcome).toBe("applied");
        expect(await balance(s)).toBe(25 * USD);
      });

      // #497-T07
      it("debits the net share of a full refund of a taxed payment: 29.75 of a 29.75 payment takes exactly the 25 credited", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const result = await apply(
          s,
          refund(s, {
            amount: toProviderAmount(29_750_000),
            paymentAmount: toProviderAmount(29_750_000),
          }),
        );

        expect(result.outcome).toBe("applied");
        expect(await balance(s)).toBe(0);
        expect((await entries(s))[0]).toMatchObject({
          type: "refund",
          amountMicroUsd: -25 * USD,
        });
        expect(await intentOf(s)).toMatchObject({
          creditedMicroUsd: 25 * USD,
          refundedMicroUsd: 25 * USD,
        });
      });

      // #497-T07
      it("debits the share of a partial refund, rounded down, whatever the unit of the provider", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        // Half of a 29.75 payment, in micro-USD.
        await apply(
          s,
          refund(s, {
            refund: "re_half",
            amount: toProviderAmount(14_875_000),
            paymentAmount: toProviderAmount(29_750_000),
          }),
        );
        // 10.00 of 29.75, in cents: 25 000 000 x 1000 / 2975 = 8 403 361.3...
        await apply(
          s,
          refund(s, {
            refund: "re_cents",
            amount: toProviderAmount(1000),
            paymentAmount: toProviderAmount(2975),
          }),
        );

        expect(
          (await entries(s))
            .filter((entry) => entry.type === "refund")
            .map((entry) => entry.amountMicroUsd)
            .sort(),
        ).toEqual([-12_500_000, -8_403_361]);
        expect(await balance(s)).toBe(25 * USD - 12_500_000 - 8_403_361);
      });

      // #497-T07
      it("debits the net share of a lost dispute of a taxed payment", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const result = await apply(
          s,
          dispute(s, {
            amount: toProviderAmount(29_750_000),
            paymentAmount: toProviderAmount(29_750_000),
          }),
        );

        expect(result.outcome).toBe("applied");
        expect(await balance(s)).toBe(0);
        expect(await intentOf(s)).toMatchObject({
          disputedMicroUsd: 25 * USD,
        });
      });

      // #497-T07
      it("rejects a refund or dispute larger than the payment it names", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const refunded = await apply(
          s,
          refund(s, {
            amount: toProviderAmount(29_750_001),
            paymentAmount: toProviderAmount(29_750_000),
          }),
        );

        expect(refunded.outcome).toBe("amount_rejected");
        expect(await balance(s)).toBe(25 * USD);
      });

      // #497-T07
      it("never debits more than the payment credited in total: two refunds of 20 on a 25 payment take 20, not 40", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const first = await apply(
          s,
          refund(s, { refund: "re_a", amount: toProviderAmount(20 * USD) }),
        );
        const second = await apply(
          s,
          refund(s, { refund: "re_b", amount: toProviderAmount(20 * USD) }),
        );

        expect(first.outcome).toBe("applied");
        expect(second).toMatchObject({
          outcome: "amount_rejected",
          needsReview: true,
        });
        expect(await balance(s)).toBe(5 * USD);
        expect(await intentOf(s)).toMatchObject({ refundedMicroUsd: 20 * USD });
      });

      // #497-T07
      it("counts refunds and disputes together: a refund of 25 and a dispute of 25 on a 25 payment take 25", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const refunded = await apply(
          s,
          refund(s, { amount: toProviderAmount(25 * USD) }),
        );
        const disputed = await apply(
          s,
          dispute(s, { amount: toProviderAmount(25 * USD) }),
        );

        expect(refunded.outcome).toBe("applied");
        expect(disputed.outcome).toBe("amount_rejected");
        expect(await balance(s)).toBe(0);
        expect(await intentOf(s)).toMatchObject({
          refundedMicroUsd: 25 * USD,
          disputedMicroUsd: 0,
        });
      });

      // #497-T07
      it("serializes refunds that arrive at the same moment, so they stay inside the credit together", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));

        const results = await Promise.all(
          ["re_a", "re_b", "re_c"].map((id) =>
            apply(
              s,
              refund(s, { refund: id, amount: toProviderAmount(20 * USD) }),
            ),
          ),
        );

        expect(
          results.filter((result) => result.outcome === "applied"),
        ).toHaveLength(1);
        expect(await balance(s)).toBe(5 * USD);
      });

      // #497-T07
      it("frees room when a refund is rejected or a dispute is won, and counts a refund once as it moves from pending to approved", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));
        await apply(
          s,
          refund(s, {
            refund: "re_a",
            amount: toProviderAmount(20 * USD),
            status: "pending",
            occurredAt: at(10),
          }),
        );
        const approved = await apply(
          s,
          refund(s, {
            refund: "re_a",
            amount: toProviderAmount(20 * USD),
            status: "approved",
            occurredAt: at(11),
          }),
        );
        expect(approved.outcome).toBe("duplicate_ignored");
        expect(await intentOf(s)).toMatchObject({ refundedMicroUsd: 20 * USD });

        await apply(
          s,
          refund(s, {
            refund: "re_a",
            amount: toProviderAmount(20 * USD),
            status: "rejected",
            occurredAt: at(12),
          }),
        );
        expect(await intentOf(s)).toMatchObject({ refundedMicroUsd: 0 });
        expect(await balance(s)).toBe(25 * USD);

        const next = await apply(
          s,
          refund(s, { refund: "re_b", amount: toProviderAmount(20 * USD) }),
        );
        expect(next.outcome).toBe("applied");

        await apply(
          s,
          dispute(s, { amount: toProviderAmount(5 * USD), occurredAt: at(20) }),
        );
        expect(await intentOf(s)).toMatchObject({ disputedMicroUsd: 5 * USD });
        await apply(
          s,
          dispute(s, {
            amount: toProviderAmount(5 * USD),
            status: "won",
            occurredAt: at(21),
          }),
        );
        expect(await intentOf(s)).toMatchObject({ disputedMicroUsd: 0 });
        expect(await balance(s)).toBe(5 * USD);
      });

      // #497-T07
      it("leaves the totals alone for a rejected refund that was never debited", async () => {
        const s = await seed(engine);
        await apply(s, succeeded(s));
        await apply(
          s,
          refund(s, { refund: "re_a", amount: toProviderAmount(20 * USD) }),
        );
        await apply(
          s,
          refund(s, { refund: "re_b", amount: toProviderAmount(20 * USD) }),
        );

        const reversal = await apply(
          s,
          refund(s, {
            refund: "re_b",
            amount: toProviderAmount(20 * USD),
            status: "rejected",
            occurredAt: at(11),
          }),
        );

        expect(reversal.outcome).toBe("nothing_to_reverse");
        expect(await intentOf(s)).toMatchObject({ refundedMicroUsd: 20 * USD });
        expect(await balance(s)).toBe(5 * USD);
      });

      // #497-T09
      it("flags every paid-but-not-credited outcome for review with a stable code, and nothing that is benign", async () => {
        const s = await seed(engine);
        const events = createBillingWebhookEventsRepository(s.db);

        const unknown = succeeded(s, {
          intentId: null,
          payment: "pi_nobody",
          checkout: null,
        });
        const tooMuch = succeeded(s, { creditable: toUsd(25 * USD + 1) });
        const unresolved = await apply(s, unknown);
        const rejected = await apply(s, tooMuch);
        const paid = await apply(s, succeeded(s));
        const refundTooEarly = refund(s, { payment: "pi_nobody" });
        const refundResult = await apply(s, refundTooEarly);
        const second = await apply(
          s,
          succeeded(s, { payment: "pi_second", checkout: "cs_second" }),
        );
        const benign = await apply(s, {
          type: "ignored",
          eventId: nextId("evt"),
          occurredAt: at(0),
        });

        expect(unresolved).toMatchObject({
          outcome: "intent_unresolved",
          needsReview: true,
        });
        expect(rejected).toMatchObject({
          outcome: "amount_rejected",
          needsReview: true,
        });
        expect(refundResult).toMatchObject({
          outcome: "intent_unresolved",
          needsReview: true,
        });
        expect(second).toMatchObject({
          outcome: "intent_unresolved",
          needsReview: true,
        });
        expect(paid).toMatchObject({ outcome: "applied", needsReview: false });
        expect(benign).toMatchObject({
          outcome: "ignored_type",
          needsReview: false,
        });
        const open = await events.listOpenReviews({ limit: 10 });
        expect(open.map((row) => row.outcome).sort()).toEqual([
          "amount_rejected",
          "intent_unresolved",
          "intent_unresolved",
          "intent_unresolved",
        ]);
        expect(
          open.find((row) => row.eventId === unknown.eventId),
        ).toMatchObject({
          subject: "payment:pi_nobody",
        });
        expect(
          open.find((row) => row.eventId === refundTooEarly.eventId),
        ).toMatchObject({
          subject: "refund:re_1",
        });
      });

      // #497-T03
      it("expires a pending intent on an expired payment, leaves a paid one alone, and lets a late payment pay an expired one", async () => {
        const s = await seed(engine);
        const expire: BillingEvent = {
          type: "payment.expired",
          eventId: nextId("evt"),
          occurredAt: at(0),
          intentId: s.intentId,
          payment: null,
          checkout: s.checkout,
        };

        const expired = await apply(s, expire);
        const again = await apply(s, { ...expire, eventId: nextId("evt") });
        expect(expired.outcome).toBe("applied");
        expect(again.outcome).toBe("duplicate_ignored");
        expect(await intentOf(s)).toMatchObject({ state: "expired" });

        await apply(s, succeeded(s));
        expect(await intentOf(s)).toMatchObject({ state: "paid" });
        const late = await apply(s, { ...expire, eventId: nextId("evt") });
        expect(late.outcome).toBe("duplicate_ignored");
        expect(await intentOf(s)).toMatchObject({ state: "paid" });
      });

      // #497-T12
      it("stores for an event an id, an outcome and an order, never the event", async () => {
        const s = await seed(engine);
        const event = refund(s);
        await apply(s, succeeded(s));
        await apply(s, event);

        const rows = await s.db
          .selectFrom("billing_webhook_events")
          .selectAll()
          .execute();

        expect(rows).toHaveLength(2);
        for (const row of rows)
          expect(Object.keys(row).sort()).toEqual([
            "event_id",
            "intent_id",
            "occurred_at",
            "outcome",
            "provider",
            "received_at",
            // Added by #603: how an operator closed a review (their id, time and note, and the journal entry), never the buyer.
            "resolution_entry_id",
            "resolution_note",
            "resolved_at",
            "resolved_by",
            "review_state",
            "subject",
            "workspace_id",
          ]);
        expect(JSON.stringify(rows)).not.toContain(String(25 * USD));
      });
    },
  );
}

for (const engine of BILLING_ENGINES) suite(engine);
