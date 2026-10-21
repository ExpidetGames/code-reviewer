// SPDX-License-Identifier: Apache-2.0

// #505: the price of a review as the Runs pages show it (ADR 0006, 2.5): the final AI price and the final infrastructure price of a
// charged review, "not charged" for a settled review that cost nothing, and nothing for a review that is still open or that was
// claimed with billing off. A review on the workspace's own key has no AI price.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createRunPriceSource } from "./run-prices.ts";

const USD = 1_000_000;

async function start() {
  const fixture = await createJobQueueFixture();
  await setBillingSwitch(fixture.db, true);
  await fundWorkspace(fixture.db, fixture.workspaceId, 50 * USD);
  const records = createUsageRecordsRepository(
    fixture.db,
    fixture.workspaceId,
    fixture.clock.now,
  );
  const journal = createBillingJournalRepository(
    fixture.db,
    fixture.workspaceId,
    fixture.clock.now,
  );
  const source = createRunPriceSource(fixture.db, fixture.workspaceId);
  /** A review with a usage record in the given state; `charge` writes the usage entry of a settled review. */
  async function review(
    prNumber: number,
    options: {
      keyMode: "own" | "managed";
      state: "open" | "settled" | "unbilled";
      charge?: { ai: number; infra: number };
    },
  ) {
    const job = await fixture.enqueueNew({ prNumber });
    await records.reserve(job.id, options.keyMode);
    if (options.state !== "unbilled") await records.openBilling(job.id);
    if (options.state === "settled") await records.closeBilling(job.id);
    if (options.charge !== undefined)
      await journal.charge(job.id, {
        aiMicroUsd: options.charge.ai,
        infraMicroUsd: options.charge.infra,
        minutes: 4,
        reviewKind: "diff",
      });
    return job.id;
  }
  return { fixture, source, review };
}

describe("the price of a review on the Runs pages", () => {
  // #505-T05
  it("gives a charged review its AI price and its infrastructure price", async () => {
    const t = await start();
    const id = await t.review(1, {
      keyMode: "managed",
      state: "settled",
      charge: { ai: 1_500_000, infra: 130_000 },
    });

    const prices = await t.source.pricesOf([id]);

    expect(prices.get(id)).toEqual({
      state: "charged",
      aiMicroUsd: 1_500_000,
      infraMicroUsd: 130_000,
    });
  });

  // #505-T05
  it("says not charged for a settled review that cost nothing", async () => {
    const t = await start();
    const id = await t.review(2, { keyMode: "managed", state: "settled" });

    expect((await t.source.pricesOf([id])).get(id)).toEqual({
      state: "not_charged",
    });
  });

  // #505-T07
  it("gives a review on the workspace's own key the infrastructure price only", async () => {
    const t = await start();
    const id = await t.review(3, {
      keyMode: "own",
      state: "settled",
      charge: { ai: 0, infra: 260_000 },
    });

    expect((await t.source.pricesOf([id])).get(id)).toEqual({
      state: "charged",
      aiMicroUsd: null,
      infraMicroUsd: 260_000,
    });
  });

  // #505-T05
  it("says nothing about a review that is still open, one that was claimed with billing off, or a job that never ran", async () => {
    const t = await start();
    const open = await t.review(4, { keyMode: "managed", state: "open" });
    const unbilled = await t.review(5, { keyMode: "managed", state: "unbilled" });
    const queued = (await t.fixture.enqueueNew({ prNumber: 6 })).id;

    const prices = await t.source.pricesOf([open, unbilled, queued]);

    expect(prices.size).toBe(0);
  });

  // #505-T02
  it("never prices a job of another workspace", async () => {
    const t = await start();
    const id = await t.review(7, {
      keyMode: "managed",
      state: "settled",
      charge: { ai: 1 * USD, infra: 100_000 },
    });
    const otherId = await addWorkspace(t.fixture.db, "other");

    const prices = await createRunPriceSource(t.fixture.db, otherId).pricesOf([id]);

    expect(prices.size).toBe(0);
  });

  // #505-T05
  it("answers for no id without a query", async () => {
    const t = await start();

    expect((await t.source.pricesOf([])).size).toBe(0);
  });
});
