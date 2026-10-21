// SPDX-License-Identifier: Apache-2.0

// #502: Stripe's webhooks end to end, on SQLite and on Postgres: the fake Stripe makes the events of a payment, a refund and a
// dispute, they are signed the way Stripe signs them and posted to the real handler (`POST /api/billing/webhook`) with the
// Stripe adapter and a real database. This is the money trust root: crediting happens only here, once per payment, from our own
// intent row, however Stripe delivers (twice, at once, late, in the wrong order).
import type { Kysely, KyselyPlugin } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { signStripeWebhook } from "../../../fakes/stripe/server.ts";
import type { StripeEvent } from "../../../fakes/stripe/server.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createBillingWebhookEventsRepository } from "../db/repositories/billing-webhook-events-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../test-support/billing-engines.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { clientFor, startTestStripe } from "../test-support/stripe-fake.ts";
import type { CreateCheckoutSessionInput } from "./stripe-client.ts";
import { isBillingOn } from "./enabled.ts";
import { createStripeAdapter } from "./stripe-adapter.ts";
import {
  createBillingWebhookHandler,
  type BillingWebhookLogger,
} from "./webhook-handler.ts";

const USD = 1_000_000;
const SECRET = "whsec_Stripe502EndToEndSecret0000000";
const API_KEY = "sk_test_FakeKeyForTests0000000000";
const BUYER_MARKERS = [
  "buyer@example.test",
  "Example GmbH",
  "DE123456789",
  "Teststrasse 1",
];

/** An event as JSON, for the ones a test changes by hand. */
type Wire = Record<string, unknown>;

class NotFound extends Error {}

function failingOn(table: string, armed: { on: boolean }): KyselyPlugin {
  return {
    transformQuery({ node }) {
      if (
        armed.on &&
        node.kind === "UpdateQueryNode" &&
        JSON.stringify(node).includes(`"${table}"`)
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
  describe.skipIf(engine.skip)(`Stripe webhooks on ${engine.name}`, () => {
    async function setup() {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      await setBillingSwitch(db, true);
      // The fake's clock: one step is one second, so the events of one story have the order they were made in.
      let clock = Date.parse("2026-10-21T10:00:00.000Z");
      const fake = await startTestStripe({ now: () => clock });
      const tick = (seconds = 1) => {
        clock += seconds * 1000;
      };
      const client = clientFor(fake);
      const adapter = createStripeAdapter({
        client: () => Promise.resolve(client),
        webhookSecret: () => Promise.resolve(SECRET),
        environment: () => Promise.resolve("test"),
      });
      const lines: string[] = [];
      const logger: BillingWebhookLogger = {
        info: (line) => lines.push(`info ${line}`),
        error: (line) => lines.push(`error ${line}`),
      };
      const build = (handlerDb: Kysely<Database>) =>
        createBillingWebhookHandler({
          db: handlerDb,
          guard: {
            isOn: () => isBillingOn(handlerDb),
            notFound: () => {
              throw new NotFound("not found");
            },
          },
          activeAdapter: () => Promise.resolve(adapter),
          logger,
          // The handler's clock is the fake's: the signature's time is the event's.
          now: () => new Date(clock),
        });
      const handler = build(db);
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const journal = createBillingJournalRepository(db, workspaceId);
      let keys = 0;

      /** The start of a top-up: the intent row first, then the session at Stripe, then (optionally) the page recorded. */
      async function startTopUp(
        options: {
          record?: boolean;
          workspace?: string;
          reference?: string;
        } = {},
      ) {
        keys += 1;
        const repository = createBillingTopUpIntentsRepository(
          db,
          options.workspace ?? workspaceId,
        );
        const intent = await repository.create({
          adapter: "stripe",
          amountMicroUsd: 25 * USD,
        });
        const reference = options.reference ?? intent.id;
        const input: CreateCheckoutSessionInput = {
          mode: "payment",
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: 2500,
                tax_behavior: "exclusive",
                product_data: {
                  name: "Review credit",
                  tax_code: "txcd_10105002",
                },
              },
            },
          ],
          success_url: "https://app.example.test/billing?topup=success",
          cancel_url: "https://app.example.test/billing?topup=cancelled",
          client_reference_id: reference,
          metadata: { intent: reference },
          managed_payments: { enabled: true },
        };
        const session = await client.createCheckoutSession(input, {
          idempotencyKey: `e2e-${keys}`,
        });
        if (options.record !== false)
          await repository.attachRefs(intent.id, { checkoutRef: session.id });
        return { intent, session };
      }

      const typesOf = (events: StripeEvent[]) => events.map((e) => e.type);
      const eventsOf = (type: string) =>
        fake.events().filter((event) => event.type === type);

      /** Posts one event the way Stripe does: the exact bytes, the signature over them, at the time of the fake's clock. */
      function post(
        event: StripeEvent | Wire | { body: string },
        options: {
          secret?: string;
          signedAt?: number;
          handler?: (request: Request) => Promise<Response>;
        } = {},
      ) {
        const body =
          "body" in event && typeof event.body === "string"
            ? event.body
            : JSON.stringify(event);
        const seconds = options.signedAt ?? Math.floor(clock / 1000);
        return (options.handler ?? handler)(
          new Request("https://app.example.test/api/billing/webhook", {
            method: "POST",
            headers: {
              "stripe-signature": signStripeWebhook(
                body,
                options.secret ?? SECRET,
                seconds,
              ),
            },
            body: new TextEncoder().encode(body),
          }),
        );
      }
      const outcomeOf = async (response: Response) =>
        (
          (await response.json()) as {
            outcome: string;
          }
        ).outcome;

      const entries = async () =>
        (await journal.entries({ limit: 100 })).entries;
      const topUps = async () =>
        (await entries()).filter((entry) => entry.type === "top_up");
      const balance = async () => (await journal.balance()).balanceMicroUsd;

      return {
        db,
        workspaceId,
        otherWorkspaceId,
        fake,
        client,
        adapter,
        lines,
        build,
        handler,
        intents,
        journal,
        startTopUp,
        tick,
        typesOf,
        eventsOf,
        post,
        outcomeOf,
        entries,
        topUps,
        balance,
        now: () => clock,
      };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;

    /** A buyer pays: the session completes with 4.75 of VAT on top. */
    const pay = (s: Setup, session: { id: string }) =>
      s.fake.buyer.pay(session.id, { taxAmount: 475 });

    // #502-T01
    it("credits the net amount once when the session completes and the payment intent succeeds, and not the VAT", async () => {
      const s = await setup();
      const { intent, session } = await s.startTopUp();
      const paid = pay(s, session);

      const responses = [];
      for (const event of s.fake.events()) responses.push(await s.post(event));

      expect(responses.map((r) => r.status)).toEqual(
        s.fake.events().map(() => 200),
      );
      expect(await s.topUps()).toMatchObject([
        {
          amountMicroUsd: 25 * USD,
          provider: "stripe",
          providerRef: paid.paymentIntent.id,
        },
      ]);
      expect(await s.balance()).toBe(25 * USD);
      expect(await s.intents.get(intent.id)).toMatchObject({
        state: "paid",
        creditedMicroUsd: 25 * USD,
        providerAmount: 2975,
        paymentRef: paid.paymentIntent.id,
      });
      expect((await s.journal.verify()).consistent).toBe(true);
    });

    // #502-T02
    it("credits once when the events arrive at once and each is delivered twice, and answers 200 to all", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      pay(s, session);
      const events = [
        ...s.eventsOf("checkout.session.completed"),
        ...s.eventsOf("payment_intent.succeeded"),
        ...s.eventsOf("charge.succeeded"),
      ];

      const responses = await Promise.all(
        [...events, ...events, ...events].map((event) => s.post(event)),
      );

      expect(new Set(responses.map((r) => r.status))).toEqual(new Set([200]));
      expect(await s.topUps()).toHaveLength(1);
      expect(await s.balance()).toBe(25 * USD);
      const outcomes = await Promise.all(
        (
          await Promise.all(
            s.eventsOf("checkout.session.completed").map((e) => s.post(e)),
          )
        ).map((r) => s.outcomeOf(r)),
      );
      expect(outcomes).toEqual(["duplicate_ignored"]);
    });

    // #502-T02
    it("credits once when two deliveries of the same event are applied on two connections", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      pay(s, session);
      const [completed] = s.eventsOf("checkout.session.completed");
      if (completed === undefined) throw new Error("no event");

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => s.post(completed)).map(async (p) =>
          s.outcomeOf(await p),
        ),
      );

      expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "duplicate_ignored")).toHaveLength(7);
      expect(await s.topUps()).toHaveLength(1);
    });

    // #502-T02
    it("credits once when the same payment arrives under two event ids at once (completed and async success)", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      pay(s, session);
      const [completed] = s.eventsOf("checkout.session.completed");
      if (completed === undefined) throw new Error("no event");
      // Stripe sends `async_payment_succeeded` for a delayed method with the session in the same shape and its own event id.
      const again: StripeEvent = {
        ...completed,
        id: "evt_async_success_of_the_same_payment",
        type: "checkout.session.async_payment_succeeded",
      };

      const outcomes = await Promise.all(
        [completed, again, completed, again].map(async (event) =>
          s.outcomeOf(await s.post(event)),
        ),
      );

      expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
      expect(await s.topUps()).toHaveLength(1);
      expect(await s.balance()).toBe(25 * USD);
    });

    // #502-T03
    it("credits a payment whose success arrives before the answer of the checkout was recorded, once", async () => {
      const s = await setup();
      // The page was created at Stripe and the buyer paid at once; our start has not yet recorded the session.
      const { intent, session } = await s.startTopUp({ record: false });
      pay(s, session);
      const [completed] = s.eventsOf("checkout.session.completed");
      if (completed === undefined) throw new Error("no event");

      const response = await s.post(completed);
      // The start then records its page: the same session the credit recorded, which is no conflict.
      await s.intents.attachRefs(intent.id, { checkoutRef: session.id });
      const again = await s.post(completed);

      expect(await s.outcomeOf(response)).toBe("applied");
      expect(await s.outcomeOf(again)).toBe("duplicate_ignored");
      expect(await s.topUps()).toHaveLength(1);
      expect(await s.intents.get(intent.id)).toMatchObject({
        state: "paid",
        checkoutRef: session.id,
      });
    });

    // #502-T03
    it("marks the intent failed on an asynchronous failure and credits nothing, and pays it once when the payment comes after all", async () => {
      const s = await setup();
      const failing = await s.startTopUp();
      s.fake.buyer.failAsync(failing.session.id);
      const [failed] = s.eventsOf("checkout.session.async_payment_failed");
      if (failed === undefined) throw new Error("no event");

      const response = await s.post(failed);

      expect(await s.outcomeOf(response)).toBe("applied");
      expect(await s.intents.get(failing.intent.id)).toMatchObject({
        state: "failed",
      });
      expect(await s.topUps()).toEqual([]);

      // A session that is paid after its intent was marked failed (the buyer retried on the page): credited, exactly once.
      const retried = await s.startTopUp();
      await s.intents.markFailed(retried.intent.id);
      pay(s, retried.session);
      const completed = s
        .eventsOf("checkout.session.completed")
        .find(
          (event) =>
            (event.data.object as { id?: string }).id === retried.session.id,
        );
      if (completed === undefined) throw new Error("no event");
      const first = await s.post(completed);
      const second = await s.post(completed);
      expect(await s.outcomeOf(first)).toBe("applied");
      expect(await s.outcomeOf(second)).toBe("duplicate_ignored");
      expect(await s.topUps()).toHaveLength(1);
      expect(await s.intents.get(retried.intent.id)).toMatchObject({
        state: "paid",
      });
    });

    // #502-T03
    it("marks an intent expired when its session expires", async () => {
      const s = await setup();
      const { intent, session } = await s.startTopUp();
      await s.client.expireCheckoutSession(session.id);
      const [expired] = s.eventsOf("checkout.session.expired");
      if (expired === undefined) throw new Error("no event");

      await s.post(expired);

      expect(await s.intents.get(intent.id)).toMatchObject({
        state: "expired",
      });
    });

    // #502-T03
    it("expires an intent whose page was never recorded (the start died after Stripe made the session) when Stripe expires the session", async () => {
      const s = await setup();
      const { intent, session } = await s.startTopUp({ record: false });
      await s.client.expireCheckoutSession(session.id);
      const [expired] = s.eventsOf("checkout.session.expired");
      if (expired === undefined) throw new Error("no event");

      const response = await s.post(expired);

      expect(await s.outcomeOf(response)).toBe("applied");
      expect(await s.intents.get(intent.id)).toMatchObject({
        state: "expired",
        checkoutRef: null,
      });
    });

    // #502-T04
    it("refuses every webhook while no webhook secret is stored: unconfigured is not open", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      pay(s, session);
      const [completed] = s.eventsOf("checkout.session.completed");
      if (completed === undefined) throw new Error("no event");
      const unconfigured = createBillingWebhookHandler({
        db: s.db,
        guard: {
          isOn: () => isBillingOn(s.db),
          notFound: () => {
            throw new NotFound("not found");
          },
        },
        activeAdapter: () =>
          Promise.resolve(
            createStripeAdapter({
              client: () => Promise.resolve(s.client),
              webhookSecret: () => Promise.resolve(null),
              environment: () => Promise.resolve("test"),
            }),
          ),
        now: () => new Date(s.now()),
      });

      const response = await s.post(completed, { handler: unconfigured });

      expect(response.status).toBe(401);
      expect(await s.topUps()).toEqual([]);
    });

    // #502-T04
    it("answers 401 with an empty body for a body signed with another secret, an altered body and an old timestamp, and changes nothing", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      pay(s, session);
      const [completed] = s.eventsOf("checkout.session.completed");
      if (completed === undefined) throw new Error("no event");
      const body = JSON.stringify(completed);

      const otherSecret = await s.post(completed, {
        secret: "whsec_NotTheStoredSecret0000000",
      });
      const altered = await s.handler(
        new Request("https://app.example.test/api/billing/webhook", {
          method: "POST",
          headers: {
            "stripe-signature": signStripeWebhook(
              body,
              SECRET,
              Math.floor(s.now() / 1000),
            ),
          },
          body: `${body} `,
        }),
      );
      const old = await s.post(completed, {
        signedAt: Math.floor(s.now() / 1000) - 3600,
      });
      const missing = await s.handler(
        new Request("https://app.example.test/api/billing/webhook", {
          method: "POST",
          body,
        }),
      );

      for (const response of [otherSecret, altered, old, missing]) {
        expect(response.status).toBe(401);
        expect(await response.text()).toBe("");
      }
      expect(await s.topUps()).toEqual([]);
      expect(
        await s.db.selectFrom("billing_webhook_events").selectAll().execute(),
      ).toEqual([]);
      expect(s.lines.join("\n")).not.toContain(session.id);
      expect(s.lines.join("\n")).not.toContain(body.slice(0, 40));
    });

    // #502-T04
    it("verifies over the raw bytes: the same JSON laid out otherwise is not the body that was signed", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      pay(s, session);
      const [completed] = s.eventsOf("checkout.session.completed");
      if (completed === undefined) throw new Error("no event");
      const signed = JSON.stringify(completed);

      const reformatted = await s.handler(
        new Request("https://app.example.test/api/billing/webhook", {
          method: "POST",
          headers: {
            "stripe-signature": signStripeWebhook(
              signed,
              SECRET,
              Math.floor(s.now() / 1000),
            ),
          },
          body: JSON.stringify(completed, null, 2),
        }),
      );

      expect(reformatted.status).toBe(401);
      expect(await s.topUps()).toEqual([]);
    });

    // #502-T05
    it("debits a refund of credit that was already spent, goes negative and refuses the next claim, until a top-up lifts it (T06)", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      const paid = pay(s, session);
      await s.post(s.eventsOf("checkout.session.completed")[0] as StripeEvent);
      // 20 of the 25 USD are spent.
      await s.journal.reserve(20 * USD, "job-1");
      await s.journal.settle("job-1", {
        aiMicroUsd: 0,
        infraMicroUsd: 20 * USD,
        minutes: 10,
        reviewKind: "diff",
      });
      s.tick();
      s.fake.stripe.refund({ paymentIntent: paid.paymentIntent.id });
      const [created] = s.eventsOf("refund.created");
      if (created === undefined) throw new Error("no event");

      const response = await s.post(created);

      expect(await s.outcomeOf(response)).toBe("applied");
      expect(
        (await s.entries()).filter((e) => e.type === "refund"),
      ).toMatchObject([{ amountMicroUsd: -25 * USD, provider: "stripe" }]);
      expect(await s.balance()).toBe(-20 * USD);
      expect(await s.journal.reserve(1 * USD, "job-2")).toMatchObject({
        ok: false,
        code: "balance_negative",
      });

      // #502-T06: a top-up that lifts the balance above zero lets claims pass again.
      const second = await s.startTopUp();
      s.tick();
      s.fake.buyer.pay(second.session.id, { taxAmount: 475 });
      const completed = s
        .eventsOf("checkout.session.completed")
        .find(
          (event) =>
            (event.data.object as { id?: string }).id === second.session.id,
        );
      await s.post(completed as StripeEvent);
      expect(await s.balance()).toBe(5 * USD);
      expect(await s.journal.reserve(1 * USD, "job-3")).toMatchObject({
        ok: true,
      });
    });

    // #502-T05
    it("debits a partial refund by its share of the credit and several refunds one by one, never more than was credited", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      const paid = pay(s, session);
      await s.post(s.eventsOf("checkout.session.completed")[0] as StripeEvent);
      s.tick();
      // 1190 of 2975 is 40 percent of the 25 USD credit; the charge.refunded list is cumulative and is not read.
      s.fake.stripe.refund({
        paymentIntent: paid.paymentIntent.id,
        amount: 1190,
      });
      s.tick();
      s.fake.stripe.refund({
        paymentIntent: paid.paymentIntent.id,
        amount: 1785,
      });

      for (const event of s.fake.events()) await s.post(event);

      expect(
        (await s.entries())
          .filter((e) => e.type === "refund")
          .map((e) => e.amountMicroUsd)
          .sort((a, b) => a - b),
      ).toEqual([-15 * USD, -10 * USD]);
      expect(await s.balance()).toBe(0);
    });

    // #502-T07
    it("books a lost dispute as a chargeback and reverses a won one once", async () => {
      const s = await setup();
      const lostSession = await s.startTopUp();
      const lostPaid = pay(s, lostSession.session);
      const wonSession = await s.startTopUp();
      const wonPaid = pay(s, wonSession.session);
      for (const event of s.eventsOf("checkout.session.completed"))
        await s.post(event);
      expect(await s.balance()).toBe(50 * USD);

      s.tick();
      const lost = s.fake.stripe.openDispute(lostPaid.charge.id);
      s.tick();
      s.fake.stripe.closeDispute(lost.dispute.id, "lost");
      s.tick();
      const won = s.fake.stripe.openDispute(wonPaid.charge.id);
      s.tick();
      s.fake.stripe.closeDispute(won.dispute.id, "won");
      for (const event of s.fake.events().filter((e) => /dispute/.test(e.type)))
        await s.post(event);

      const entries = await s.entries();
      expect(
        entries
          .filter((e) => e.type === "chargeback")
          .map((e) => [e.providerRef, e.amountMicroUsd])
          .sort(),
      ).toEqual(
        [
          [lost.dispute.id, -25 * USD],
          [won.dispute.id, -25 * USD],
        ].sort(),
      );
      expect(entries.filter((e) => e.type === "correction")).toMatchObject([
        { amountMicroUsd: 25 * USD, providerRef: won.dispute.id },
      ]);
      expect(await s.balance()).toBe(25 * USD);
      expect((await s.journal.verify()).consistent).toBe(true);
    });

    // #502-T08
    it("leaves the state of one correct delivery when refund and dispute events are reordered or duplicated", async () => {
      const ordered = await setup();
      const shuffled = await setup();
      const stories = async (
        s: Setup,
        deliver: (events: StripeEvent[]) => Promise<void>,
      ) => {
        const { session } = await s.startTopUp();
        const paid = pay(s, session);
        await s.post(
          s.eventsOf("checkout.session.completed")[0] as StripeEvent,
        );
        const before = s.fake.events().length;
        s.tick();
        const refund = s.fake.stripe.refund({
          paymentIntent: paid.paymentIntent.id,
          amount: 1190,
        });
        s.tick();
        s.fake.stripe.failRefund(refund.refund.id);
        s.tick();
        const dispute = s.fake.stripe.openDispute(paid.charge.id);
        s.tick();
        s.fake.stripe.closeDispute(dispute.dispute.id, "won");
        await deliver(s.fake.events().slice(before));
      };

      await stories(ordered, async (events) => {
        for (const event of events) await ordered.post(event);
      });
      await stories(shuffled, async (events) => {
        // Newest first, every one twice, and one more time at the end.
        const reversed = [...events].reverse();
        for (const event of [...reversed, ...reversed, ...events])
          await shuffled.post(event);
      });

      expect(await shuffled.balance()).toBe(await ordered.balance());
      expect(await shuffled.balance()).toBe(25 * USD);
      const rows = async (s: Setup) =>
        (await s.entries()).filter(
          (e) => e.type === "chargeback" || e.type === "refund",
        ).length;
      // The dispute's debit is stale when the win is seen first, and a refund that failed first is never debited.
      expect(await rows(shuffled)).toBeLessThanOrEqual(await rows(ordered));
      expect((await shuffled.journal.verify()).consistent).toBe(true);
      const intent = (
        await createBillingTopUpIntentsRepository(
          shuffled.db,
          shuffled.workspaceId,
        ).list({ limit: 5 })
      )[0];
      expect(intent).toMatchObject({
        refundedMicroUsd: 0,
        disputedMicroUsd: 0,
      });
    });

    // #502-T09
    it("acknowledges an event of an intent we do not know and a type we do not use, with 200 and no change", async () => {
      const s = await setup();
      // A session whose reference is no intent of ours (a payment made elsewhere on the same Stripe account).
      const stranger = await s.client.createCheckoutSession(
        {
          mode: "payment",
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: 2500,
                tax_behavior: "exclusive",
                product_data: { name: "Other", tax_code: "txcd_10105002" },
              },
            },
          ],
          success_url: "https://app.example.test/billing",
          cancel_url: "https://app.example.test/billing",
          client_reference_id: "not-one-of-ours",
          metadata: { intent: "not-one-of-ours" },
          managed_payments: { enabled: true },
        },
        { idempotencyKey: "e2e-stranger" },
      );
      pay(s, stranger);
      const [completed] = s.eventsOf("checkout.session.completed");
      const [unrelated] = s.eventsOf("customer.created");
      if (completed === undefined) throw new Error("no event");

      const unknownIntent = await s.post(completed);
      const unknownType = await s.post(
        unrelated ?? {
          ...completed,
          id: "evt_other",
          type: "customer.created",
        },
      );

      expect(unknownIntent.status).toBe(200);
      expect(await s.outcomeOf(unknownIntent)).toBe("intent_unresolved");
      expect(unknownType.status).toBe(200);
      expect(await s.outcomeOf(unknownType)).toBe("ignored_type");
      expect(await s.topUps()).toEqual([]);
      expect(
        await createBillingWebhookEventsRepository(s.db).listOpenReviews({
          limit: 10,
        }),
      ).toHaveLength(1);
      expect(
        s.lines.some((l) => l.startsWith("error billing_webhook_needs_review")),
      ).toBe(true);
    });

    // #502-T09
    it("refuses and flags a paid session in another currency, and one of the other environment, and credits nothing", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      pay(s, session);
      const [completed] = s.eventsOf("checkout.session.completed");
      if (completed === undefined) throw new Error("no event");
      const withSession = (patch: Record<string, unknown>): Wire => ({
        ...completed,
        id: `evt_${Object.keys(patch).join("_")}`,
        data: { object: { ...(completed.data.object as object), ...patch } },
      });

      const euro = await s.post(withSession({ currency: "eur" }));
      const other = await s.post({
        ...withSession({}),
        id: "evt_live",
        livemode: true,
      });

      expect(await s.outcomeOf(euro)).toBe("amount_rejected");
      expect(other.status).toBe(400);
      expect(await s.topUps()).toEqual([]);
      expect(
        await createBillingWebhookEventsRepository(s.db).listOpenReviews({
          limit: 10,
        }),
      ).toHaveLength(1);
    });

    // #502-T10
    it("answers 500 and applies nothing when the handler fails, and the redelivery applies it", async () => {
      const s = await setup();
      const { intent, session } = await s.startTopUp();
      pay(s, session);
      const [completed] = s.eventsOf("checkout.session.completed");
      if (completed === undefined) throw new Error("no event");
      const armed = { on: true };
      const failing = s.build(
        s.db.withPlugin(failingOn("billing_topup_intents", armed)),
      );

      const failed = await s.post(completed, { handler: failing });

      expect(failed.status).toBe(500);
      expect(await failed.text()).toBe("");
      expect(await s.topUps()).toEqual([]);
      expect(await s.intents.get(intent.id)).toMatchObject({
        state: "pending",
      });
      expect(await s.balance()).toBe(0);

      armed.on = false;
      const redelivered = await s.post(completed, { handler: failing });

      expect(await s.outcomeOf(redelivered)).toBe("applied");
      expect(await s.topUps()).toHaveLength(1);
    });

    // #502-T13
    it("keeps no payload, email, address, VAT ID, key or secret in the logs or in any billing table", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      pay(s, session);
      const [completed] = s.eventsOf("checkout.session.completed");
      if (completed === undefined) throw new Error("no event");
      // Stripe's real session carries the buyer's details; the app must read none of them.
      const withBuyer = {
        ...completed,
        data: {
          object: {
            ...(completed.data.object as object),
            customer_email: "buyer@example.test",
            customer_details: {
              email: "buyer@example.test",
              name: "Example GmbH",
              address: { line1: "Teststrasse 1", country: "DE" },
              tax_ids: [{ type: "eu_vat", value: "DE123456789" }],
            },
          },
        },
      } as Wire;

      const response = await s.post(withBuyer);
      await s.post({ ...withBuyer, id: "evt_bad", type: "refund.created" });
      await s.post(withBuyer, { secret: "whsec_wrong_secret_0000000000" });
      const answers = await response.clone().text();

      const dump = JSON.stringify({
        logs: s.lines,
        answers,
        events: await s.db
          .selectFrom("billing_webhook_events")
          .selectAll()
          .execute(),
        journal: await s.entries(),
        intents: await s.db
          .selectFrom("billing_topup_intents")
          .selectAll()
          .execute(),
      });
      for (const marker of [...BUYER_MARKERS, SECRET, API_KEY, "cus_"])
        expect(dump, marker).not.toContain(marker);
    });

    // #502-T14
    it("makes no outbound call while it handles any event", async () => {
      const s = await setup();
      const { session } = await s.startTopUp();
      const paid = pay(s, session);
      s.fake.stripe.refund({
        paymentIntent: paid.paymentIntent.id,
        amount: 500,
      });
      const dispute = s.fake.stripe.openDispute(paid.charge.id);
      s.fake.stripe.closeDispute(dispute.dispute.id, "lost");
      const sent = s.fake.requests().length;
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        for (const event of s.fake.events()) await s.post(event);

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(s.fake.requests()).toHaveLength(sent);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
}

for (const engine of BILLING_ENGINES) suite(engine);
