// SPDX-License-Identifier: Apache-2.0

// #505: the Runs list and the run detail carry the price of a review while billing is on (ADR 0006, 2.5): the final AI and
// infrastructure price of a charged review, "not charged" for a free one, only the infrastructure price on the workspace's own
// key, and no price at all when billing is off or the review was not billed. Nothing but the two final prices leaves.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createRunPriceSource } from "../billing/run-prices.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createRunsFixture } from "../test-support/runs.ts";
import { createRunsService } from "./runs-service.ts";

const USD = 1_000_000;

async function start(options: { pricesOn?: boolean } = {}) {
  const f = await createRunsFixture();
  await setBillingSwitch(f.db, true);
  await fundWorkspace(f.db, f.workspaceId, 50 * USD);
  const source = createRunPriceSource(f.db, f.workspaceId);
  const service = createRunsService({
    runs: f.runsRepository,
    now: f.clock.now,
    ...(options.pricesOn === false
      ? {}
      : { prices: (ids: readonly string[]) => source.pricesOf(ids) }),
  });
  const records = createUsageRecordsRepository(
    f.db,
    f.workspaceId,
    f.clock.now,
  );
  const journal = createBillingJournalRepository(
    f.db,
    f.workspaceId,
    f.clock.now,
  );
  async function billed(
    keyMode: "own" | "managed",
    charge: { ai: number; infra: number } | null,
  ) {
    const job = await f.waiting();
    await records.reserve(job.id, keyMode);
    await records.openBilling(job.id);
    await records.closeBilling(job.id);
    if (charge !== null)
      await journal.charge(job.id, {
        aiMicroUsd: charge.ai,
        infraMicroUsd: charge.infra,
        minutes: 6,
        reviewKind: "diff",
      });
    return job.id;
  }
  return { f, service, billed };
}

describe("the price of a review in the Runs list and the run detail", () => {
  // #505-T05
  it("shows the two prices of a charged review and not charged for a free one, in the list and in the detail", async () => {
    const t = await start();
    const charged = await t.billed("managed", {
      ai: 1_500_000,
      infra: 130_000,
    });
    const free = await t.billed("managed", null);

    const list = await t.service.list({});
    const detail = await t.service.get(charged);

    expect(list.runs.find((run) => run.id === charged)?.price).toEqual({
      state: "charged",
      aiMicroUsd: 1_500_000,
      infraMicroUsd: 130_000,
    });
    expect(list.runs.find((run) => run.id === free)?.price).toEqual({
      state: "not_charged",
    });
    expect(detail?.run.price).toEqual({
      state: "charged",
      aiMicroUsd: 1_500_000,
      infraMicroUsd: 130_000,
    });
  });

  // #505-T07
  it("shows only the infrastructure price of a review on the workspace's own key", async () => {
    const t = await start();
    const id = await t.billed("own", { ai: 0, infra: 260_000 });

    expect((await t.service.get(id))?.run.price).toEqual({
      state: "charged",
      aiMicroUsd: null,
      infraMicroUsd: 260_000,
    });
  });

  // #505-T11
  it("carries no price at all without a price source (billing off)", async () => {
    const t = await start({ pricesOn: false });
    const id = await t.billed("managed", { ai: 1 * USD, infra: 100_000 });

    const list = await t.service.list({});
    const detail = await t.service.get(id);

    expect(list.runs.every((run) => !("price" in run))).toBe(true);
    expect(detail?.run && "price" in detail.run).toBe(false);
  });

  // #505-T06
  it("sends nothing of a charge but the two final prices: no rate, no minutes, no factor, no cost of our key", async () => {
    const t = await start();
    const id = await t.billed("managed", { ai: 1_500_000, infra: 130_000 });

    const body = JSON.stringify({
      list: await t.service.list({}),
      detail: await t.service.get(id),
    });

    const price = (await t.service.get(id))?.run.price;
    expect(Object.keys(price ?? {}).sort()).toEqual([
      "aiMicroUsd",
      "infraMicroUsd",
      "state",
    ]);
    for (const word of ["minutes", "factor", "costusd"])
      expect(body.toLowerCase()).not.toContain(word);
    expect(JSON.stringify(price)).not.toContain("rate");
  });
});
