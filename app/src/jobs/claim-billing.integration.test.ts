// SPDX-License-Identifier: LicenseRef-Proprietary

// Billing at the claim (#605, which replaces the hold of #498; ADR 0006, 2.8): while billing is on, the claim starts a job
// whenever the workspace's balance is above zero and holds nothing, or refuses it without leaving a record or an entry. The
// price is charged when the job ends (settle-jobs.integration.test.ts). Made-up rates (test-support/billing-switch.ts): A = 5.0, B(Diff) = 13,000, B(Dynamic) = 16,000 micro-USD a minute.
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { isBillingOn } from "../billing/enabled.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createLlmKeyModeStore } from "../llm/key-mode-store.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import {
  TEST_BILLING_RATES,
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import {
  createJobQueueFixture,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import type { EntitlementsData } from "../workspaces/entitlements.ts";
import type { ClaimRefusal } from "../db/repositories/claim-admission.ts";
import { createRunnerQueue } from "./runner-queue.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const ENGINES = ["pr-agent", "opencode"] as const;
/** One cent: far below what any hold of #498 would have been. */
const ONE_CENT = 10_000;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

function entitlements(keyMode: "own" | "managed"): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode,
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
  };
}

describe("the claim with billing", () => {
  async function start(
    options: {
      onRefused?: (refusal: ClaimRefusal) => void;
      rates?: Parameters<typeof setBillingSwitch>[2];
    } = {},
  ) {
    const database = await open();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      dynamicReview: true,
      ...(options.onRefused === undefined
        ? {}
        : { onRefused: options.onRefused }),
    });
    await setBillingSwitch(fixture.db, true, options.rates);
    return fixture;
  }

  const journalOf = (fixture: JobQueueFixture) =>
    createBillingJournalRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );

  const setKeyMode = (fixture: JobQueueFixture, keyMode: "own" | "managed") =>
    createWorkspaceEntitlementsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ).put(entitlements(keyMode), null);

  const usageRecords = (fixture: JobQueueFixture) =>
    fixture.db.selectFrom("usage_records").selectAll().execute();

  let pr = 100;
  function enqueue(
    fixture: JobQueueFixture,
    reviewKind: "diff" | "dynamic" = "diff",
  ) {
    pr += 1;
    fixture.clock.advance(1);
    return fixture.enqueueNew({ prNumber: pr, reviewKind });
  }

  const entryTypes = async (fixture: JobQueueFixture) =>
    (await journalOf(fixture).entries({ limit: 20 })).entries.map(
      (entry) => entry.type,
    );

  // #605-T01
  it("starts a Dynamic job on the operator's key with one cent of balance and holds nothing", async () => {
    const fixture = await start();
    await setKeyMode(fixture, "managed");
    await fundWorkspace(fixture.db, fixture.workspaceId, ONE_CENT);
    const job = await enqueue(fixture, "dynamic");

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed?.job.id).toBe(job.id);
    expect(await usageRecords(fixture)).toEqual([
      expect.objectContaining({
        job_id: job.id,
        state: "reserved",
        billing_state: "open",
      }),
    ]);
    // No reservation: the only entry is the top-up, and the balance and the reserve are untouched.
    expect(await entryTypes(fixture)).toEqual(["top_up"]);
    expect(await journalOf(fixture).balance()).toEqual({
      balanceMicroUsd: ONE_CENT,
      reservedMicroUsd: 0,
    });
    expect(await journalOf(fixture).verify()).toMatchObject({
      consistent: true,
    });
  });

  // #605-T01
  it("starts a Diff job on the workspace's own key with one cent", async () => {
    const fixture = await start();
    await fundWorkspace(fixture.db, fixture.workspaceId, ONE_CENT);
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed?.job.id).toBe(job.id);
    expect(await entryTypes(fixture)).toEqual(["top_up"]);
  });

  // #605-T02
  it("refuses a job when the balance is zero, leaving no record and no entry, and reports it for a notice", async () => {
    const refusals: ClaimRefusal[] = [];
    const fixture = await start({
      onRefused: (refusal) => refusals.push(refusal),
    });
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed).toBeNull();
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "insufficient_balance",
      attempts: 0,
      runnerId: null,
    });
    expect(await usageRecords(fixture)).toEqual([]);
    expect((await journalOf(fixture).entries({ limit: 10 })).entries).toEqual(
      [],
    );
    expect(refusals).toEqual([
      expect.objectContaining({
        jobId: job.id,
        workspaceId: fixture.workspaceId,
        errorCode: "insufficient_balance",
      }),
    ]);
  });

  // #605-T02
  it("refuses a job when a balance that was positive is spent down to exactly zero", async () => {
    const fixture = await start();
    await fundWorkspace(fixture.db, fixture.workspaceId, ONE_CENT);
    await journalOf(fixture).append({
      type: "correction",
      amountMicroUsd: -ONE_CENT,
      refKey: "spent",
      note: "spent",
    });
    const job = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "insufficient_balance",
    });
  });

  // #605-T03
  it("refuses a job when the balance is below zero, also when the job cannot cost anything", async () => {
    const fixture = await start({
      rates: {
        factorA: 50_000,
        minuteRateMicroUsd: { diff: 0, dynamic: 16_000 },
        diffAiReserveMicroUsd: 150_000,
      },
    });
    await fundWorkspace(fixture.db, fixture.workspaceId, 1_000);
    await journalOf(fixture).append({
      type: "refund",
      amountMicroUsd: -5_000,
      provider: "manual",
      providerRef: "refund-1",
      refKey: "refund-1",
    });
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed).toBeNull();
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "balance_negative",
    });
    expect(await usageRecords(fixture)).toEqual([]);
  });

  // #605-T03
  it("lets a job that cannot cost anything (own key, a rate of zero) run on a balance of zero", async () => {
    const fixture = await start({
      rates: {
        factorA: 50_000,
        minuteRateMicroUsd: { diff: 0, dynamic: 16_000 },
        diffAiReserveMicroUsd: 150_000,
      },
    });
    // Billing on: a workspace that has not chosen is on our models (#496); this one chose its own key.
    await createLlmKeyModeStore(fixture.db, fixture.workspaceId).set(
      "own",
      null,
    );
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed?.job.id).toBe(job.id);
    expect(await entryTypes(fixture)).toEqual([]);
    expect(await usageRecords(fixture)).toHaveLength(1);
  });

  // #605-T04
  it("starts every one of many jobs claimed at the same moment on a balance of one cent, which stays as it is", async () => {
    const fixture = await start();
    await fundWorkspace(fixture.db, fixture.workspaceId, ONE_CENT);
    for (let index = 0; index < 8; index += 1) await enqueue(fixture);

    // Two or more connections of one pool (the processes test races real processes).
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fixture.queue.claimNext(`runner-${String(index)}`, ENGINES),
      ),
    );

    expect(answers.filter((answer) => answer !== null)).toHaveLength(8);
    expect(await usageRecords(fixture)).toHaveLength(8);
    expect(await entryTypes(fixture)).toEqual(["top_up"]);
    expect(await journalOf(fixture).balance()).toEqual({
      balanceMicroUsd: ONE_CENT,
      reservedMicroUsd: 0,
    });
    expect(await journalOf(fixture).verify()).toMatchObject({
      consistent: true,
    });
  });

  // #605-T05
  it("writes no entry for a job claimed again after a lost lease, and keeps its one record", async () => {
    const fixture = await start();
    await fundWorkspace(fixture.db, fixture.workspaceId, ONE_CENT);
    const job = await enqueue(fixture);
    const first = await fixture.queue.claimNext("runner-a", ENGINES);
    expect(first?.job.id).toBe(job.id);
    await fixture.queue.release(
      job.id,
      first?.leaseToken ?? "",
      "worker_exited",
    );

    const second = await fixture.queue.claimNext("runner-b", ENGINES);

    expect(second?.job.id).toBe(job.id);
    expect(await usageRecords(fixture)).toEqual([
      expect.objectContaining({ job_id: job.id, billing_state: "open" }),
    ]);
    expect(await entryTypes(fixture)).toEqual(["top_up"]);
  });

  // #605-T06
  it("marks a job claimed again with billing on as billed when its first claim was made with billing off", async () => {
    const fixture = await start();
    await fundWorkspace(fixture.db, fixture.workspaceId, ONE_CENT);
    await setBillingSwitch(fixture.db, false);
    const job = await enqueue(fixture);
    const first = await fixture.queue.claimNext("runner-a", ENGINES);
    expect(await usageRecords(fixture)).toEqual([
      expect.objectContaining({ billing_state: null }),
    ]);
    await fixture.queue.release(
      job.id,
      first?.leaseToken ?? "",
      "worker_exited",
    );
    await setBillingSwitch(fixture.db, true);

    const second = await fixture.queue.claimNext("runner-b", ENGINES);

    expect(second?.job.id).toBe(job.id);
    expect(await usageRecords(fixture)).toEqual([
      expect.objectContaining({ billing_state: "open" }),
    ]);
  });

  // #498-T15
  it("refuses the job with billing_rates_incomplete while billing is on and a rate is missing", async () => {
    const fixture = await start({ rates: null });
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed).toBeNull();
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "billing_rates_incomplete",
    });
    expect(await usageRecords(fixture)).toEqual([]);
  });

  // #498-T18
  it("refuses the job with billing_rates_incomplete and holds nothing while the switch is set and the Stripe adapter is not ready", async () => {
    const fixture = await start();
    await createInstanceSettingsRepository(fixture.db).set(
      "billing_settings",
      { enabled: true, adapter: "stripe", ...TEST_BILLING_RATES },
      null,
    );
    expect(await isBillingOn(fixture.db), "billing is not on").toBe(false);
    await fundWorkspace(fixture.db, fixture.workspaceId, 1_000_000);
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed).toBeNull();
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "billing_rates_incomplete",
    });
    expect(await usageRecords(fixture)).toEqual([]);
    expect(await journalOf(fixture).balance()).toEqual({
      balanceMicroUsd: 1_000_000,
      reservedMicroUsd: 0,
    });
  });

  // #498-T23
  it("claims as with billing off when the stored billing setting is text that is no JSON, and settles nothing", async () => {
    const fixture = await start();
    await fixture.db
      .updateTable("instance_settings")
      .set({ value: "not json {" })
      .where("key", "=", "billing_settings")
      .execute();
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
    await fixture.queue.complete(job.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: { ok: true },
    });

    expect(claimed?.job.id).toBe(job.id);
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "succeeded",
    });
    expect(
      await fixture.db
        .selectFrom("billing_journal_entries")
        .selectAll()
        .execute(),
    ).toEqual([]);
  });

  // #498-T15
  it("reads no billing table and writes no entry while billing is off, and the claim is as before", async () => {
    const fixture = await start();
    await setBillingSwitch(fixture.db, false);
    const seen: string[] = [];
    const spy = fixture.db.withPlugin({
      transformQuery: ({ node }) => {
        seen.push(JSON.stringify(node));
        return node;
      },
      transformResult: (args) => Promise.resolve(args.result),
    });
    const queue = createRunnerQueue(spy, { now: fixture.clock.now });
    const job = await enqueue(fixture);

    const claimed = await queue.claimNext("runner-a", ENGINES);
    await queue.complete(job.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {
        ok: true,
        usage: {
          promptTokens: 10,
          completionTokens: 1,
          costUsd: 0.5,
          aiCalls: 1,
        },
      },
    });

    expect(claimed?.job.id).toBe(job.id);
    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen.filter((query) => /"name":"billing_[a-z_]+"/.test(query)),
    ).toEqual([]);
    expect(await usageRecords(fixture)).toEqual([
      expect.objectContaining({
        state: "settled",
        cost_micro_usd: 500_000,
        billing_state: null,
      }),
    ]);
    expect(
      await fixture.db
        .selectFrom("billing_journal_entries")
        .selectAll()
        .execute(),
    ).toEqual([]);
    expect(
      await fixture.db.selectFrom("billing_balances").selectAll().execute(),
    ).toEqual([]);
  });
});
