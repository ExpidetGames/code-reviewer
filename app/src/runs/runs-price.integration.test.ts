// SPDX-License-Identifier: LicenseRef-Proprietary

// #505: the Runs list and the run detail carry the price of a review while billing is on (ADR 0006, 2.5): the final AI and
// infrastructure price of a charged review, "not charged" for a free one, only the infrastructure price on the workspace's own
// key, and no price at all when billing is off or the review was not billed. Nothing but the two final prices leaves.
import { describe, expect, it as vitestIt } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createRunPriceSource } from "../billing/run-prices.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
import { createRunsFixture } from "../test-support/runs.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createRunsService } from "./runs-service.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { getProductIdentity } from "../product-identity/current.ts";

const PRODUCT = getProductIdentity();

const USD = 1_000_000;
const it = vitestIt;

async function start(options: { pricesOn?: boolean } = {}) {
  const f = await createRunsFixture();
  await setBillingSwitch(f.db, true);
  await fundWorkspace(f.db, f.workspaceId, 50 * USD);
  const source = createRunPriceSource(f.db, f.workspaceId);
  const service = createRunsService({
    product: PRODUCT,
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
  return { f, service, billed, journal };
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

  // #657-T01
  it("shows the settled price of a review: a late-minutes correction is part of what the run cost, in the list and in the detail", async () => {
    const t = await start();
    const id = await t.billed("managed", { ai: 1_500_000, infra: 130_000 });
    // The late end of the VM credits 5 of the 10 minutes charged at 13,000 micro-USD: the run finally cost 65,000 of infrastructure.
    await t.journal.append({
      type: "correction",
      amountMicroUsd: 65_000,
      jobId: id,
      refKey: `late-minutes:${id}`,
      note: "late end of the VM",
    });
    const settled = {
      state: "charged",
      aiMicroUsd: 1_500_000,
      infraMicroUsd: 65_000,
    };

    const list = await t.service.list({});
    const detail = await t.service.get(id);

    expect(list.runs.find((run) => run.id === id)?.price).toEqual(settled);
    expect(detail?.run.price).toEqual(settled);
  });

  // #657-T01
  it("says not charged when corrections took back the whole charge", async () => {
    const t = await start();
    const id = await t.billed("own", { ai: 0, infra: 130_000 });
    await t.journal.append({
      type: "correction",
      amountMicroUsd: 130_000,
      jobId: id,
      refKey: `late-minutes:${id}`,
    });

    expect((await t.service.get(id))?.run.price).toEqual({
      state: "not_charged",
    });
  });
});

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

// #657-T01: what the price source takes from the corrections. A correction moves the infrastructure part of the
// run it names, inside the workspace of the source and nowhere else.
describe("the corrections in the price of a review", () => {
  async function setup() {
    const database = await open();
    const f = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
    });
    await setBillingSwitch(f.db, true);
    const otherWorkspaceId = await addWorkspace(f.db, "prices-b");
    await fundWorkspace(f.db, f.workspaceId, 50 * USD);
    await fundWorkspace(f.db, otherWorkspaceId, 50 * USD);
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
    const otherJournal = createBillingJournalRepository(
      f.db,
      otherWorkspaceId,
      f.clock.now,
    );
    const job = await f.enqueueNew({ prNumber: 7 });
    await records.reserve(job.id, "managed");
    await records.openBilling(job.id);
    await records.closeBilling(job.id);
    await journal.charge(job.id, {
      aiMicroUsd: 1_500_000,
      infraMicroUsd: 130_000,
      minutes: 10,
      reviewKind: "diff",
    });
    const priceOf = async (workspaceId: string) =>
      (await createRunPriceSource(f.db, workspaceId).pricesOf([job.id])).get(
        job.id,
      );
    const correct = (on: typeof journal, amountMicroUsd: number, key: string) =>
      on.append({
        type: "correction",
        amountMicroUsd,
        jobId: job.id,
        refKey: `${key}:${job.id}`,
      });
    return {
      journal,
      otherJournal,
      correct,
      priceOf,
      workspaceId: f.workspaceId,
      otherWorkspaceId,
    };
  }
  const charged = (infraMicroUsd: number) => ({
    state: "charged",
    aiMicroUsd: 1_500_000,
    infraMicroUsd,
  });

  it("leaves the price alone when another workspace holds a correction for the same job id", async () => {
    const t = await setup();
    // The journal has no foreign key on the job id: another workspace can hold a correction that names this job's id.
    await t.correct(t.otherJournal, 130_000, "late-minutes");

    expect(await t.priceOf(t.workspaceId)).toEqual(charged(130_000));
  });

  it("adds up several corrections of one run", async () => {
    const t = await setup();
    await t.correct(t.journal, 30_000, "late-minutes");
    await t.correct(t.journal, 20_000, "late-minutes-2");

    expect(await t.priceOf(t.workspaceId)).toEqual(charged(80_000));
  });

  it("raises the price with a negative correction, an extra charge", async () => {
    const t = await setup();
    await t.correct(t.journal, -20_000, "late-minutes");

    expect(await t.priceOf(t.workspaceId)).toEqual(charged(150_000));
  });
});
