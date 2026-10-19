// SPDX-License-Identifier: Apache-2.0

// The suite every billing adapter must pass (#497; ADR 0006, 2.12). An adapter is only a reader of its provider: this kit
// pins what the rest of the application relies on. `describeAdapterContract` (a unit suite) checks the adapter's id and
// capabilities, that it parses its own fixtures into the normalized events, refuses a bad signature with a stable code
// and without echoing anything, and makes no outbound call while it parses. `describeAdapterApplication` (an integration
// suite, on every engine) applies what it parsed: the same event twice, an event for the same payment under another
// event id, and events in the wrong order leave the state of one correct delivery, and money is never credited twice.
// The manual adapter passes it with no webhook; the fake adapter (`fake-billing-adapter.ts`) passes it with one, and so
// will the Stripe adapter with its recorded fixtures (#502).
import { describe, expect, it, vi } from "vitest";
import {
  BILLING_WEBHOOK_REJECTION_CODES,
  assertValidCapabilities,
  createAdapterRegistry,
  isAdapterId,
  validateBillingEvent,
  type BillingAdapter,
  type BillingEvent,
  type BillingWebhookRejectionCode,
} from "../billing/adapter.ts";
import { applyBillingEvent } from "../billing/apply-event.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import type { BillingEngine } from "./billing-engines.ts";

export type WebhookRequest = { headers: Headers; rawBody: string };

export type AdapterKitSubject = {
  name: string;
  create: () => BillingAdapter;
  /** Absent for an adapter that receives no webhooks (`manual`). */
  webhook?: {
    now: Date;
    /** Requests the adapter must parse, each into the event it names. */
    valid: Array<{
      label: string;
      request: WebhookRequest;
      expected: BillingEvent;
    }>;
    /** Requests it must refuse, each with its code: missing, wrong, altered, old. */
    rejected: Array<{
      label: string;
      request: WebhookRequest;
      code: BillingWebhookRejectionCode;
    }>;
  };
};

export function describeAdapterContract(subject: AdapterKitSubject): void {
  describe(`the adapter contract: ${subject.name}`, () => {
    const adapter = subject.create();

    // #497-T14
    it("has an id and capabilities the registry accepts, and a top-up range inside 10 to 500 USD", () => {
      expect(isAdapterId(adapter.id)).toBe(true);
      expect(() =>
        assertValidCapabilities(adapter.id, adapter.capabilities),
      ).not.toThrow();
      expect(() => createAdapterRegistry([adapter])).not.toThrow();
    });

    // #497-T14
    it("offers no way to refund and no auto-recharge: refunds are events only", () => {
      expect("refund" in adapter).toBe(false);
      expect(Object.keys(adapter.capabilities)).not.toContain("autoRecharge");
    });

    // #497-T14
    it("starts a top-up only as a redirect or as none", async () => {
      const started = await adapter.createTopUpCheckout({
        customer: null,
        intentId: "intent-kit",
        amount: 25_000_000,
        returnUrl: "https://app.example.test/billing",
      });
      expect(["redirect", "none"]).toContain(started.checkout.kind);
      if (started.checkout.kind === "redirect")
        expect(started.checkout.url).toMatch(/^https:\/\//);
    });

    if (subject.webhook === undefined) {
      // #497-T14
      it("has no webhook, so the route answers the missing path", () => {
        expect(adapter.verifyAndParseWebhook).toBeUndefined();
      });
      return;
    }
    const webhook = subject.webhook;
    const verify = (request: WebhookRequest) => {
      if (adapter.verifyAndParseWebhook === undefined)
        throw new Error("the adapter declares a webhook but has no verifier");
      return adapter.verifyAndParseWebhook({ ...request, now: webhook.now });
    };

    // #497-T14
    it("parses each of its fixtures into the normalized event, with amounts and ids the application accepts", async () => {
      expect(webhook.valid.length).toBeGreaterThan(0);
      for (const { label, request, expected } of webhook.valid) {
        const result = await verify(request);
        expect(result, label).toEqual({ ok: true, event: expected });
        expect(() => validateBillingEvent(expected), label).not.toThrow();
        // Parsing is a pure function of the request: the same request gives the same event.
        expect(await verify(request), label).toEqual(result);
      }
    });

    // #497-T14
    it("refuses a missing, wrong, altered or old signature with a stable code and nothing else", async () => {
      expect(webhook.rejected.length).toBeGreaterThan(0);
      for (const { label, request, code } of webhook.rejected) {
        const result = await verify(request);
        expect(BILLING_WEBHOOK_REJECTION_CODES, label).toContain(code);
        expect(result, label).toEqual({ ok: false, code });
        // The answer carries the code only: no body, no header, no secret.
        expect(JSON.stringify(result), label).not.toContain(
          request.rawBody.slice(0, 20),
        );
      }
    });

    // #497-T14
    it("makes no outbound call while it verifies and parses", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        for (const { request } of [...webhook.valid, ...webhook.rejected])
          await verify(request);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
}

/**
 * What the application suite needs from an adapter with a webhook: the requests for one payment of an intent the suite
 * created. `paid` and `paidAgain` are two deliveries of the same payment under different event ids (a provider that sends
 * `checkout.session.completed` and `payment_intent.succeeded`); `refunded` is a refund of part of it.
 */
export type ApplicationFixtures = {
  paid: WebhookRequest;
  paidAgain: WebhookRequest;
  refunded: WebhookRequest;
  /** What the refund takes, in micro-USD. */
  refundAmount: number;
};

export type ApplicationSubject = {
  name: string;
  create: () => BillingAdapter;
  now: Date;
  fixtures: (input: {
    intentId: string;
    amount: number;
  }) => ApplicationFixtures;
};

export function describeAdapterApplication(
  subject: ApplicationSubject,
  engines: BillingEngine[],
): void {
  const amount = 25_000_000;

  for (const engine of engines) {
    describe.skipIf(engine.skip)(
      `applying the events of ${subject.name} on ${engine.name}`,
      () => {
        async function prepare() {
          const { db, workspaceId } = await engine.create();
          const adapter = subject.create();
          const intent = await createBillingTopUpIntentsRepository(
            db,
            workspaceId,
          ).create({
            adapter: adapter.id,
            amountMicroUsd: amount,
          });
          const fixtures = subject.fixtures({ intentId: intent.id, amount });
          const parse = async (
            request: WebhookRequest,
          ): Promise<BillingEvent> => {
            const result = await adapter.verifyAndParseWebhook?.({
              ...request,
              now: subject.now,
            });
            if (result === undefined || !result.ok)
              throw new Error("a fixture of the adapter was not accepted");
            return result.event;
          };
          const apply = async (request: WebhookRequest) =>
            applyBillingEvent(db, {
              provider: adapter.id,
              event: await parse(request),
            });
          const journal = createBillingJournalRepository(db, workspaceId);
          return { db, adapter, fixtures, apply, journal };
        }

        // #497-T14
        it("credits a payment once, however often and under whichever event id it arrives, also at once", async () => {
          const { fixtures, apply, journal } = await prepare();

          const results = await Promise.all([
            apply(fixtures.paid),
            apply(fixtures.paid),
            apply(fixtures.paidAgain),
            apply(fixtures.paidAgain),
          ]);
          await apply(fixtures.paid);

          expect(
            results.filter((result) => result.outcome === "applied"),
          ).toHaveLength(1);
          expect((await journal.balance()).balanceMicroUsd).toBe(amount);
          expect(
            (await journal.entries({ limit: 20 })).entries.filter(
              (entry) => entry.type === "top_up",
            ),
          ).toHaveLength(1);
          expect((await journal.verify()).consistent).toBe(true);
        });

        // #497-T14
        it("leaves the state of one correct delivery when the refund arrives first and is delivered again", async () => {
          const ordered = await prepare();
          await ordered.apply(ordered.fixtures.paid);
          await ordered.apply(ordered.fixtures.refunded);

          const reordered = await prepare();
          const early = await reordered.apply(reordered.fixtures.refunded);
          await reordered.apply(reordered.fixtures.paid);
          // The provider delivers the refund again; it applies now that the payment is known.
          await reordered.apply(reordered.fixtures.refunded);
          await reordered.apply(reordered.fixtures.refunded);

          expect(early.outcome).toBe("intent_unresolved");
          const expected = amount - ordered.fixtures.refundAmount;
          expect((await ordered.journal.balance()).balanceMicroUsd).toBe(
            expected,
          );
          expect((await reordered.journal.balance()).balanceMicroUsd).toBe(
            expected,
          );
          expect((await reordered.journal.verify()).consistent).toBe(true);
        });
      },
    );
  }
}
