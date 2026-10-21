// SPDX-License-Identifier: Apache-2.0

// The hold at claim (#498; ADR 0006, 2.8): while billing is on, the claim takes a hold from the workspace's balance in the
// same transaction that reserves the usage record, or refuses the job without leaving a record or an entry. On SQLite and,
// when TEST_DATABASE_URL is set, on Postgres. Made-up rates (test-support/billing-switch.ts): A = 5.0, B(Diff) = 13,000,
// B(Dynamic) = 16,000 micro-USD a minute, so a Diff hold is 25 minutes x 13,000 = 325,000 on the workspace's own key, and a
// Dynamic hold on the operator's key is 25 x 16,000 + 1,000,000 x 5.0 = 5,400,000.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { isBillingOn } from "../billing/enabled.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  TEST_BILLING_RATES,
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import {
  createJobQueueFixture,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import type { EntitlementsData } from "../workspaces/entitlements.ts";
import type { ClaimRefusal } from "../db/repositories/claim-admission.ts";
import { createRunnerQueue } from "./runner-queue.ts";

const ENGINES = ["pr-agent", "opencode"] as const;
const DIFF_OWN_HOLD = 325_000;
const DYNAMIC_MANAGED_HOLD = 5_400_000;

const databases: Array<
  [string, (() => Promise<Kysely<Database>>) | undefined]
> = [
  ["SQLite", undefined],
  [
    "Postgres",
    hasPostgres()
      ? async () => (await createPostgresTestDatabase({ poolMax: 12 })).db
      : undefined,
  ],
];

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

describe.each(databases)("the hold at claim on %s", (name, open) => {
  const run = name === "Postgres" && open === undefined ? it.skip : it;

  async function start(
    options: {
      onRefused?: (refusal: ClaimRefusal) => void;
      rates?: Parameters<typeof setBillingSwitch>[2];
    } = {},
  ) {
    const database = await open?.();
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

  // #498-T01
  run(
    "reserves the usage record and a hold of the longest minutes and the budget for a Dynamic job on the operator's key",
    async () => {
      const fixture = await start();
      await setKeyMode(fixture, "managed");
      await fundWorkspace(fixture.db, fixture.workspaceId, 10_000_000);
      const job = await enqueue(fixture, "dynamic");

      const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

      expect(claimed?.job.id).toBe(job.id);
      expect(await usageRecords(fixture)).toEqual([
        expect.objectContaining({ job_id: job.id, state: "reserved" }),
      ]);
      const { entries } = await journalOf(fixture).entries({ limit: 10 });
      expect(
        entries.map((entry) => [entry.type, entry.amountMicroUsd]),
      ).toEqual([
        ["reservation", -DYNAMIC_MANAGED_HOLD],
        ["top_up", 10_000_000],
      ]);
      expect(entries[0]).toMatchObject({ jobId: job.id, refKey: job.id });
      expect(await journalOf(fixture).balance()).toEqual({
        balanceMicroUsd: 10_000_000 - DYNAMIC_MANAGED_HOLD,
        reservedMicroUsd: DYNAMIC_MANAGED_HOLD,
      });
    },
  );

  // #498-T02
  run(
    "holds the minutes only for a job on the workspace's own key",
    async () => {
      const fixture = await start();
      await fundWorkspace(fixture.db, fixture.workspaceId, 1_000_000);
      const job = await enqueue(fixture);

      await fixture.queue.claimNext("runner-a", ENGINES);

      const reservation = await journalOf(fixture).findByKey(
        "reservation",
        job.id,
      );
      expect(reservation?.amountMicroUsd).toBe(-DIFF_OWN_HOLD);
    },
  );

  // #498-T02
  run(
    "holds the minutes only for an own-key Dynamic job, whatever its cost limit",
    async () => {
      const fixture = await start();
      await setKeyMode(fixture, "own");
      await fundWorkspace(fixture.db, fixture.workspaceId, 1_000_000);
      const job = await enqueue(fixture, "dynamic");

      await fixture.queue.claimNext("runner-a", ENGINES);

      expect(
        (await journalOf(fixture).findByKey("reservation", job.id))
          ?.amountMicroUsd,
      ).toBe(-25 * 16_000);
    },
  );

  // #498-T01
  run("holds the AI reserve of a Diff job on the operator's key", async () => {
    const fixture = await start();
    await setKeyMode(fixture, "managed");
    await fundWorkspace(fixture.db, fixture.workspaceId, 10_000_000);
    const job = await enqueue(fixture);

    await fixture.queue.claimNext("runner-a", ENGINES);

    // 25 x 13,000 for the minutes, 150,000 x 5.0 for the AI.
    expect(
      (await journalOf(fixture).findByKey("reservation", job.id))
        ?.amountMicroUsd,
    ).toBe(-(325_000 + 750_000));
  });

  // #498-T03
  run(
    "refuses a job when nothing can be held, leaving no record and no entry, and reports it for a notice",
    async () => {
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
    },
  );

  // #498-T03
  run(
    "holds no more than the balance when the balance is below the hold (decision 5 of #489)",
    async () => {
      const fixture = await start();
      await fundWorkspace(fixture.db, fixture.workspaceId, 100_000);
      const job = await enqueue(fixture);

      const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

      expect(claimed?.job.id).toBe(job.id);
      expect(
        (await journalOf(fixture).findByKey("reservation", job.id))
          ?.amountMicroUsd,
      ).toBe(-100_000);
      expect(await journalOf(fixture).balance()).toEqual({
        balanceMicroUsd: 0,
        reservedMicroUsd: 100_000,
      });
    },
  );

  // #498-T04
  run(
    "refuses a job when the balance is below zero, also when the hold is zero",
    async () => {
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
    },
  );

  // #498-T04
  run("lets a job with a hold of zero run on a balance of zero", async () => {
    const fixture = await start({
      rates: {
        factorA: 50_000,
        minuteRateMicroUsd: { diff: 0, dynamic: 16_000 },
        diffAiReserveMicroUsd: 150_000,
      },
    });
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed?.job.id).toBe(job.id);
    expect(await journalOf(fixture).findByKey("reservation", job.id)).toBe(
      undefined,
    );
    expect(await usageRecords(fixture)).toHaveLength(1);
  });

  // #498-T05
  run(
    "lets exactly one of two claims at the same moment take the last of a balance",
    async () => {
      const fixture = await start();
      await fundWorkspace(fixture.db, fixture.workspaceId, DIFF_OWN_HOLD);
      const one = await enqueue(fixture);
      const two = await enqueue(fixture);

      // Two connections of one pool on Postgres; on SQLite the database lock serializes them (the processes test
      // races two real processes).
      const answers = await Promise.all([
        fixture.queue.claimNext("runner-a", ENGINES),
        fixture.queue.claimNext("runner-b", ENGINES),
      ]);

      expect(answers.filter((answer) => answer !== null)).toHaveLength(1);
      const statuses = await Promise.all(
        [one, two].map(
          async (job) => (await fixture.queue.get(job.id))?.status,
        ),
      );
      expect(statuses.sort()).toEqual(["failed", "running"]);
      expect(await usageRecords(fixture)).toHaveLength(1);
      expect(await journalOf(fixture).verify()).toMatchObject({
        consistent: true,
        balanceMicroUsd: 0,
      });
    },
  );

  // #498-T05
  run(
    "never lets many claims at the same moment hold more than the balance",
    async () => {
      const fixture = await start();
      await fundWorkspace(fixture.db, fixture.workspaceId, DIFF_OWN_HOLD * 3);
      for (let index = 0; index < 8; index += 1) await enqueue(fixture);

      const answers = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          fixture.queue.claimNext(`runner-${String(index)}`, ENGINES),
        ),
      );

      expect(answers.filter((answer) => answer !== null)).toHaveLength(3);
      expect(await journalOf(fixture).balance()).toEqual({
        balanceMicroUsd: 0,
        reservedMicroUsd: DIFF_OWN_HOLD * 3,
      });
    },
  );

  // #498-T01
  run(
    "takes the hold once for a job claimed again after a lost lease",
    async () => {
      const fixture = await start();
      await fundWorkspace(fixture.db, fixture.workspaceId, 1_000_000);
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
      expect(await usageRecords(fixture)).toHaveLength(1);
      expect(
        (await journalOf(fixture).entries({ limit: 10 })).entries.map(
          (entry) => entry.type,
        ),
      ).toEqual(["reservation", "top_up"]);
    },
  );

  // #498-T15
  run(
    "refuses the job with billing_rates_incomplete while billing is on and a rate is missing",
    async () => {
      const fixture = await start({ rates: null });
      const job = await enqueue(fixture);

      const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

      expect(claimed).toBeNull();
      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "billing_rates_incomplete",
      });
      expect(await usageRecords(fixture)).toEqual([]);
    },
  );

  // #498-T18
  run(
    "refuses the job with billing_rates_incomplete and holds nothing while the switch is set and the Stripe adapter is not ready",
    async () => {
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
    },
  );

  // #498-T15
  run(
    "reads no billing table and writes no entry while billing is off, and the claim is as before",
    async () => {
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
    },
  );
});
