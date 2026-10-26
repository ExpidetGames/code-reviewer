// SPDX-License-Identifier: LicenseRef-Proprietary

// The service of the billing review rows (#603) over a real database ,
// with several requests in flight at once (every connection of the pool is its own): the journal holds at most one entry for a
// row however the credit is asked for (whatever type, however often, at the same moment), and a request that loses the race
// for the close says so and leaves the winner's resolution as it was.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createBillingWebhookEventsRepository } from "../db/repositories/billing-webhook-events-repository.ts";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../test-support/billing-engines.ts";
import { createBillingCreditService } from "./admin-credit-service.ts";
import {
  createBillingReviewService,
  reviewRequestId,
} from "./admin-review-service.ts";

const USD = 1_000_000;

function suite(engine: BillingEngine) {
  describe(`resolving a billing review row at the same moment on ${engine.name}`, () => {
    async function setup(options: { subject: string }) {
      const { db, workspaceId } = await engine.create();
      const events = createBillingWebhookEventsRepository(db);
      const credit = createBillingCreditService({ db });
      const logs: string[] = [];
      const service = createBillingReviewService({
        db,
        credit,
        log: (line) => logs.push(line),
      });
      await createBillingTopUpIntentsRepository(db, workspaceId).create({
        id: "intent-1",
        adapter: "stripe",
        amountMicroUsd: 25 * USD,
      });
      await events.claim("stripe", "evt_1", "2026-10-21T08:00:00.000Z");
      await events.finish(
        "stripe",
        "evt_1",
        "amount_rejected",
        { subject: options.subject, occurredAt: null },
        true,
        { workspaceId, intentId: "intent-1" },
      );
      return {
        db,
        workspaceId,
        events,
        credit,
        service,
        logs,
        entries: async () =>
          (
            await createBillingJournalRepository(db, workspaceId).entries({
              limit: 20,
            })
          ).entries,
      };
    }

    const body = (
      credit: Record<string, unknown>,
      note = "credited by hand",
    ) => ({ provider: "stripe", eventId: "evt_1", note, credit });
    const pending = { intentState: "pending" };

    // #603-T26
    it("writes one entry when a credit and a correction are asked for a payment row at the same moment", async () => {
      const { service, entries } = await setup({ subject: "payment:pi_1" });

      const answers = await Promise.all([
        service.resolve(
          "admin-1",
          body({ type: "credit", amountMicroUsd: 10 * USD, ...pending }),
        ),
        service.resolve(
          "admin-2",
          body({ type: "correction", amountMicroUsd: -10 * USD, ...pending }),
        ),
      ]);

      const written = await entries();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ type: "top_up" });
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    });

    // #603-T26
    it("writes one entry when a credit and a correction are asked for a refund row at the same moment", async () => {
      const { service, entries } = await setup({ subject: "refund:re_1" });

      await Promise.all([
        service.resolve(
          "admin-1",
          body({ type: "credit", amountMicroUsd: 10 * USD, ...pending }),
        ),
        service.resolve(
          "admin-2",
          body({ type: "correction", amountMicroUsd: -10 * USD, ...pending }),
        ),
      ]);

      const written = await entries();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ type: "correction" });
    });

    // #603-T26
    it("keeps the request id of a row apart for each type, so a second type could never share an entry's key", () => {
      expect(reviewRequestId("stripe", "evt_1", "credit")).not.toBe(
        reviewRequestId("stripe", "evt_1", "correction"),
      );
      expect(reviewRequestId("stripe", "evt_1", "credit")).toBe(
        reviewRequestId("stripe", "evt_1", "credit"),
      );
    });

    // #603-T27
    it("writes one entry and closes the row once when the same credit is sent twice at the same moment", async () => {
      const { service, events, entries } = await setup({
        subject: "payment:pi_1",
      });
      const send = (adminId: string) =>
        service.resolve(
          adminId,
          body({ type: "credit", amountMicroUsd: 10 * USD, ...pending }),
        );

      const answers = await Promise.all([send("admin-1"), send("admin-2")]);

      const written = await entries();
      expect(written).toHaveLength(1);
      expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
      expect(
        answers.filter(
          (answer) => !answer.ok && answer.error === "review_already_resolved",
        ),
      ).toHaveLength(1);
      const row = await events.getReview("stripe", "evt_1");
      expect(row).toMatchObject({
        reviewState: "resolved",
        resolution: { entryId: written[0]!.id },
      });
    });

    // #603-T27
    it("keeps the resolution of the request that closed the row when another one loses the race for the close", async () => {
      const { db, workspaceId, events, credit, logs } = await setup({
        subject: "payment:pi_1",
      });
      // Between the read of the row and its close, another admin closes it (after the credit, as a retry would).
      const racing = createBillingReviewService({
        db,
        log: (line) => logs.push(line),
        credit: {
          ...credit,
          async credit(adminId, id, input) {
            const result = await credit.credit(adminId, id, input);
            await events.resolveReview("stripe", "evt_1", {
              resolvedBy: "admin-winner",
              note: "closed first",
              entryId: result.ok ? result.entryId : null,
              at: "2026-10-21T12:00:00.000Z",
            });
            return result;
          },
        },
      });

      const answer = await racing.resolve(
        "admin-late",
        body({ type: "credit", amountMicroUsd: 10 * USD, ...pending }),
      );

      expect(answer).toEqual({ ok: false, error: "review_already_resolved" });
      expect(await events.getReview("stripe", "evt_1")).toMatchObject({
        reviewState: "resolved",
        resolution: { resolvedBy: "admin-winner", note: "closed first" },
      });
      expect(
        logs.filter((line) => line.startsWith("billing_review_resolved")),
      ).toEqual([]);
      expect(
        (
          await createBillingJournalRepository(db, workspaceId).entries({
            limit: 20,
          })
        ).entries,
      ).toHaveLength(1);
    });
  });
}

for (const engine of BILLING_ENGINES) suite(engine);
