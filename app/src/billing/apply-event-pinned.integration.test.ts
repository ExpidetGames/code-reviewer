// SPDX-License-Identifier: Apache-2.0

// #502: what the application pins when it credits a payment (the amount the buyer was charged, in the provider's unit) and
// what it does with the events a provider sends without it (a Stripe refund names its own amount and no total), plus the
// refused payment and the payment of an intent that failed before. On SQLite and on Postgres.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../test-support/billing-engines.ts";
import { toProviderAmount, toUsd, type BillingEvent } from "./adapter.ts";
import { applyBillingEvent } from "./apply-event.ts";

const USD = 1_000_000;
const PROVIDER = "fake";
let counter = 0;
const nextId = (prefix: string) => `${prefix}_p${(counter += 1)}`;
const at = (minutes: number) =>
  new Date(
    Date.parse("2026-10-19T08:00:00.000Z") + minutes * 60_000,
  ).toISOString();

async function seed(engine: BillingEngine) {
  const { db, workspaceId } = await engine.create();
  const intent = await createBillingTopUpIntentsRepository(
    db,
    workspaceId,
  ).create({ adapter: PROVIDER, amountMicroUsd: 25 * USD });
  return {
    db,
    workspaceId,
    intentId: intent.id,
    payment: nextId("pi"),
    checkout: nextId("cs"),
  };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

function paid(
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
    providerAmount: toProviderAmount(2975),
    providerCurrency: "usd",
    ...overrides,
  };
}

function refundOf(
  s: Seeded,
  overrides: Partial<Extract<BillingEvent, { type: "refund.updated" }>> = {},
): BillingEvent {
  return {
    type: "refund.updated",
    eventId: nextId("evt"),
    occurredAt: at(10),
    payment: s.payment,
    refund: nextId("re"),
    amount: toProviderAmount(1190),
    initiatedBy: "provider",
    status: "approved",
    ...overrides,
  };
}

const apply = (s: Seeded, event: BillingEvent) =>
  applyBillingEvent(s.db, { provider: PROVIDER, event });
const journal = (s: Seeded) =>
  createBillingJournalRepository(s.db, s.workspaceId);
const intentOf = (s: Seeded) =>
  createBillingTopUpIntentsRepository(s.db, s.workspaceId).get(s.intentId);

function suite(engine: BillingEngine) {
  describe.skipIf(engine.skip)(
    `pinned payment amount on ${engine.name}`,
    () => {
      // #502-T05
      it("debits the share of a refund that names only its own amount, against the amount pinned when the payment was credited", async () => {
        const s = await seed(engine);
        await apply(s, paid(s));

        const result = await apply(s, refundOf(s));

        // 1190 of 2975 cents is 40 percent of the 25 USD credit.
        expect(result.outcome).toBe("applied");
        expect((await journal(s).balance()).balanceMicroUsd).toBe(15 * USD);
        expect(await intentOf(s)).toMatchObject({
          providerAmount: 2975,
          refundedMicroUsd: 10 * USD,
        });
      });

      // #502-T05
      it("takes a full refund as the whole credit", async () => {
        const s = await seed(engine);
        await apply(s, paid(s));

        await apply(s, refundOf(s, { amount: toProviderAmount(2975) }));

        expect((await journal(s).balance()).balanceMicroUsd).toBe(0);
      });

      // #502-T08
      it("refuses a refund with no total to relate it to, for a payment that pinned none", async () => {
        const s = await seed(engine);
        await apply(s, paid(s, { providerAmount: undefined as never }));

        const result = await apply(s, refundOf(s));

        expect(result).toMatchObject({
          outcome: "amount_rejected",
          needsReview: true,
        });
        expect((await journal(s).balance()).balanceMicroUsd).toBe(25 * USD);
      });

      // #502-T08
      it("flags an event whose total contradicts the pinned one, and changes nothing", async () => {
        const s = await seed(engine);
        await apply(s, paid(s));

        const result = await apply(
          s,
          refundOf(s, { paymentAmount: toProviderAmount(2900) }),
        );

        expect(result).toMatchObject({
          outcome: "amount_conflict",
          needsReview: true,
        });
        expect((await journal(s).balance()).balanceMicroUsd).toBe(25 * USD);
      });

      // #502-T08
      it("accepts an event whose total agrees with the pinned one", async () => {
        const s = await seed(engine);
        await apply(s, paid(s));

        const result = await apply(
          s,
          refundOf(s, { paymentAmount: toProviderAmount(2975) }),
        );

        expect(result.outcome).toBe("applied");
      });

      // #502-T08
      it("keeps the first pinned amount when the same payment is told again with another one", async () => {
        const s = await seed(engine);
        await apply(s, paid(s));

        await apply(s, paid(s, { providerAmount: toProviderAmount(5000) }));

        expect(await intentOf(s)).toMatchObject({ providerAmount: 2975 });
      });

      // #502-T09
      it("records a refused payment for review and credits nothing", async () => {
        const s = await seed(engine);

        const result = await apply(s, {
          type: "payment.refused",
          eventId: nextId("evt"),
          occurredAt: at(0),
          payment: s.payment,
        });

        expect(result).toMatchObject({
          outcome: "amount_rejected",
          needsReview: true,
        });
        expect((await journal(s).balance()).balanceMicroUsd).toBe(0);
        expect(await intentOf(s)).toMatchObject({ state: "pending" });
        const rows = await s.db
          .selectFrom("billing_webhook_events")
          .select(["outcome", "review_state", "subject"])
          .execute();
        expect(rows).toEqual([
          {
            outcome: "amount_rejected",
            review_state: "open",
            subject: `payment:${s.payment}`,
          },
        ]);
      });

      // #502-T16
      it("rejects a refund in another currency than the payment was pinned in, and flags it with whose payment it is", async () => {
        const s = await seed(engine);
        await apply(s, paid(s));

        // The whole payment in euros: 2200 EUR cents is no share of 2975 USD cents.
        const result = await apply(
          s,
          refundOf(s, { amount: toProviderAmount(2200), currency: "eur" }),
        );

        expect(result).toMatchObject({
          outcome: "amount_rejected",
          needsReview: true,
          workspaceId: s.workspaceId,
        });
        expect((await journal(s).balance()).balanceMicroUsd).toBe(25 * USD);
        expect(await intentOf(s)).toMatchObject({ refundedMicroUsd: 0 });
        // #502-T19
        expect(
          await s.db
            .selectFrom("billing_webhook_events")
            .select(["outcome", "review_state", "workspace_id", "intent_id"])
            .where("outcome", "=", "amount_rejected")
            .execute(),
        ).toEqual([
          {
            outcome: "amount_rejected",
            review_state: "open",
            workspace_id: s.workspaceId,
            intent_id: s.intentId,
          },
        ]);
      });

      // #502-T16
      it("rejects a dispute in another currency, and takes a refund in the pinned currency or one that names none", async () => {
        const s = await seed(engine);
        await apply(s, paid(s));

        const euro = await apply(s, {
          type: "dispute.updated",
          eventId: nextId("evt"),
          occurredAt: at(5),
          payment: s.payment,
          dispute: nextId("dp"),
          amount: toProviderAmount(2975),
          currency: "eur",
          status: "opened",
        });
        const dollars = await apply(
          s,
          refundOf(s, { amount: toProviderAmount(1190), currency: "usd" }),
        );
        const silent = await apply(
          s,
          refundOf(s, { amount: toProviderAmount(1190) }),
        );

        expect(euro.outcome).toBe("amount_rejected");
        expect(dollars.outcome).toBe("applied");
        expect(silent.outcome).toBe("applied");
        expect((await journal(s).balance()).balanceMicroUsd).toBe(5 * USD);
      });

      // #502-T16
      it("rejects a refund that names a currency for a payment that pinned none", async () => {
        const s = await seed(engine);
        await apply(
          s,
          paid(s, {
            providerCurrency: undefined as never,
          }),
        );
        expect(await intentOf(s)).toMatchObject({
          providerAmount: 2975,
          providerCurrency: null,
        });

        const result = await apply(s, refundOf(s, { currency: "usd" }));

        expect(result).toMatchObject({
          outcome: "amount_rejected",
          needsReview: true,
        });
        expect((await journal(s).balance()).balanceMicroUsd).toBe(25 * USD);
      });

      // #502-T16
      it("keeps the first pinned currency when the same payment is told again with another one", async () => {
        const s = await seed(engine);
        await apply(s, paid(s));

        await apply(s, paid(s, { providerCurrency: "eur" }));

        expect(await intentOf(s)).toMatchObject({ providerCurrency: "usd" });
      });

      // #502-T19
      it("names the workspace and the intent on the review of a refused payment that names our intent", async () => {
        const s = await seed(engine);

        const result = await apply(s, {
          type: "payment.refused",
          eventId: nextId("evt"),
          occurredAt: at(0),
          payment: s.payment,
          intentId: s.intentId,
        });

        expect(result).toMatchObject({
          outcome: "amount_rejected",
          workspaceId: s.workspaceId,
          needsReview: true,
        });
        expect(
          await s.db
            .selectFrom("billing_webhook_events")
            .select(["workspace_id", "intent_id"])
            .execute(),
        ).toEqual([{ workspace_id: s.workspaceId, intent_id: s.intentId }]);
      });

      // #502-T19
      it("leaves the workspace and the intent empty on the review of a refused payment that names none of ours", async () => {
        const s = await seed(engine);

        await apply(s, {
          type: "payment.refused",
          eventId: nextId("evt"),
          occurredAt: at(0),
          payment: s.payment,
          intentId: "not-one-of-ours",
        });

        expect(
          await s.db
            .selectFrom("billing_webhook_events")
            .select(["workspace_id", "intent_id"])
            .execute(),
        ).toEqual([{ workspace_id: null, intent_id: null }]);
      });

      // #502-T03
      it("pays an intent that was marked failed before, once, however the success is told", async () => {
        const s = await seed(engine);
        await apply(s, {
          type: "payment.failed",
          eventId: nextId("evt"),
          occurredAt: at(0),
          intentId: s.intentId,
          payment: null,
          checkout: null,
        });
        expect(await intentOf(s)).toMatchObject({ state: "failed" });

        const first = await apply(s, paid(s));
        const again = await apply(s, paid(s));

        expect(first.outcome).toBe("applied");
        expect(again.outcome).toBe("duplicate_ignored");
        expect(await intentOf(s)).toMatchObject({ state: "paid" });
        expect((await journal(s).balance()).balanceMicroUsd).toBe(25 * USD);
      });
    },
  );
}

for (const engine of BILLING_ENGINES) suite(engine);
