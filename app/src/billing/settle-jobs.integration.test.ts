// SPDX-License-Identifier: Apache-2.0

// The settlement of a job's hold (#498; ADR 0006, 2.6 and 2.8): in the transaction that ends the job, the journal gets a
// `release` of the hold and, unless the outcome is free, a `usage` entry with the AI and infrastructure parts. On SQLite and,
// when TEST_DATABASE_URL is set, on Postgres. Made-up rates (test-support/billing-switch.ts): A = 5.0, B(Diff) = 13,000,
// B(Dynamic) = 16,000 micro-USD a minute, a Diff AI reserve of 150,000. A run whose VM lived 90 seconds is 2 started minutes.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createBillingJournalRepository,
  type JournalEntry,
} from "../db/repositories/billing-journal-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import { createUsageFeedRepository } from "../db/repositories/usage-feed-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import {
  createJobQueueFixture,
  sha,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import type { EntitlementsData } from "../workspaces/entitlements.ts";
import type { Job } from "../jobs/job-types.ts";
import type { JobOutcome } from "../jobs/job-types.ts";

const ENGINES = ["pr-agent", "opencode"] as const;
const SECOND = 1000;

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

function entitlements(
  keyMode: "own" | "managed",
  suspended = false,
): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode,
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended,
    suspensionCode: suspended ? "operator" : null,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
  };
}

const delivered = (
  costUsd: number | null,
  extra: Record<string, unknown> = {},
): JobOutcome => ({
  ok: true,
  result: {
    ok: true,
    usage: {
      promptTokens: 100,
      completionTokens: 10,
      costUsd,
      aiCalls: 1,
      ...extra,
    },
  },
});

describe.each(databases)("the settlement of a hold on %s", (name, open) => {
  const run = name === "Postgres" && open === undefined ? it.skip : it;

  async function start(
    options: {
      keyMode?: "own" | "managed";
      funding?: number;
      maxAttempts?: number;
    } = {},
  ) {
    const database = await open?.();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      dynamicReview: true,
      ...(options.maxAttempts === undefined
        ? {}
        : { limits: { maxAttempts: options.maxAttempts } }),
    });
    await setBillingSwitch(fixture.db, true);
    if (options.keyMode !== undefined)
      await createWorkspaceEntitlementsRepository(
        fixture.db,
        fixture.workspaceId,
        fixture.clock.now,
      ).put(entitlements(options.keyMode), null);
    await fundWorkspace(
      fixture.db,
      fixture.workspaceId,
      options.funding ?? 100_000_000,
    );
    return fixture;
  }

  const journalOf = (fixture: JobQueueFixture) =>
    createBillingJournalRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
  const vmRunsOf = (fixture: JobQueueFixture) =>
    createJobVmRunsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
  const recordsOf = (fixture: JobQueueFixture) =>
    createUsageRecordsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );

  /** The entries of one job, oldest first. */
  async function entriesOf(
    fixture: JobQueueFixture,
    jobId: string,
  ): Promise<JournalEntry[]> {
    const { entries } = await journalOf(fixture).entries({ limit: 200 });
    return entries.filter((entry) => entry.jobId === jobId).reverse();
  }

  let pr = 100;
  type Claimed = { job: Job; leaseToken: string };

  /**
   * Enqueues and claims a job; the Dispatcher's report of its VM is recorded at the claim, and `vmSeconds` later the stop of
   * the VM is confirmed, so the job measures `ceil(vmSeconds / 60)` started minutes. `vmSeconds: null` records no VM.
   */
  async function claim(
    fixture: JobQueueFixture,
    options: {
      kind?: "diff" | "dynamic";
      managed?: boolean;
      vmSeconds?: number | null;
      acceptsSupersede?: boolean;
    } = {},
  ): Promise<Claimed> {
    pr += 1;
    fixture.clock.advance(1);
    const job = await fixture.enqueueNew({
      prNumber: pr,
      reviewKind: options.kind ?? "diff",
    });
    const claimed = await fixture.queue.claimNext(
      "runner-a",
      ENGINES,
      options.acceptsSupersede === true ? { acceptsSupersede: true } : {},
    );
    if (claimed === null || claimed.job.id !== job.id)
      throw new Error("The job was not claimed.");
    if (options.managed === true)
      await recordsOf(fixture).setKeyMode(job.id, "managed");
    const vmSeconds = options.vmSeconds === undefined ? 90 : options.vmSeconds;
    if (vmSeconds !== null)
      await recordVm(fixture, claimed.job, vmSeconds, "vm-1");
    return { job: claimed.job, leaseToken: claimed.leaseToken };
  }

  /** The Dispatcher reported the VM of the claim, now. */
  async function startVm(fixture: JobQueueFixture, job: Job, vmName: string) {
    const current = await fixture.queue.get(job.id);
    expect(
      await vmRunsOf(fixture).recordStart({
        jobId: job.id,
        vmName,
        claimedAt: current?.claimedAt ?? "",
        attempt: 1,
        startedAt: fixture.clock.now(),
        vmTimeoutSeconds: 1500,
      }),
    ).toBe("recorded");
  }

  /** The Dispatcher reported the VM at the claim; the App's stop call was answered `seconds` later. */
  async function recordVm(
    fixture: JobQueueFixture,
    job: Job,
    seconds: number,
    vmName: string,
  ) {
    await startVm(fixture, job, vmName);
    fixture.clock.advance(seconds * SECOND);
    await vmRunsOf(fixture).confirmStopped(
      job.id,
      [vmName],
      fixture.clock.now(),
    );
  }

  const shape = (entries: JournalEntry[]) =>
    entries.map((entry) => [entry.type, entry.amountMicroUsd]);

  // #498-T06
  run(
    "releases the hold and charges the AI and the infrastructure part of a delivered result with a known cost",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, { managed: true });

      await fixture.queue.complete(job.id, leaseToken, delivered(0.5));

      const entries = await entriesOf(fixture, job.id);
      // The hold was 25 x 13,000 for the minutes and 150,000 x 5.0 for the AI; the price is 500,000 x 5.0 and 2 x 13,000.
      expect(shape(entries)).toEqual([
        ["reservation", -1_075_000],
        ["release", 1_075_000],
        ["usage", -2_526_000],
      ]);
      expect(entries[2]).toMatchObject({
        aiMicroUsd: 2_500_000,
        infraMicroUsd: 26_000,
        minutes: 2,
        reviewKind: "diff",
      });
      expect(await journalOf(fixture).balance()).toEqual({
        balanceMicroUsd: 100_000_000 - 2_526_000,
        reservedMicroUsd: 0,
      });
      expect(await journalOf(fixture).verify()).toMatchObject({
        consistent: true,
      });
    },
  );

  // #498-T17
  run(
    "keeps the real cost in the usage record and the operator feed, not the price",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, { managed: true });

      await fixture.queue.complete(job.id, leaseToken, delivered(0.5));

      expect(await recordsOf(fixture).get(job.id)).toMatchObject({
        state: "settled",
        costMicroUsd: 500_000,
      });
      const feed = await createUsageFeedRepository(fixture.db).pageSettled({
        limit: 10,
      });
      expect(feed.records).toEqual([
        expect.objectContaining({ jobId: job.id, costMicroUsd: 500_000 }),
      ]);
    },
  );

  // #498-T07
  run(
    "charges the full price of a Diff run above its hold, takes the balance below zero and refuses the next claim",
    async () => {
      const fixture = await start({ keyMode: "managed", funding: 1_075_000 });
      const { job, leaseToken } = await claim(fixture, { managed: true });

      await fixture.queue.complete(job.id, leaseToken, delivered(2));

      // AI 2,000,000 x 5.0 = 10,000,000 and 2 minutes x 13,000.
      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -1_075_000],
        ["release", 1_075_000],
        ["usage", -10_026_000],
      ]);
      expect((await journalOf(fixture).balance()).balanceMicroUsd).toBe(
        1_075_000 - 10_026_000,
      );
      const next = await fixture.enqueueNew({
        prNumber: 900,
        headSha: sha("c"),
      });
      expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
      expect(await fixture.queue.get(next.id)).toMatchObject({
        status: "failed",
        errorCode: "balance_negative",
      });
    },
  );

  // #498-T07b
  run(
    "charges the full price of a Dynamic run above its hold (usage.limitExceededBy), and refuses the next claim",
    async () => {
      const fixture = await start({ keyMode: "managed", funding: 5_400_000 });
      const { job, leaseToken } = await claim(fixture, {
        kind: "dynamic",
        managed: true,
      });
      expect((await journalOf(fixture).balance()).balanceMicroUsd).toBe(0);

      await fixture.queue.complete(
        job.id,
        leaseToken,
        delivered(1.34, { limitExceededBy: 0.34 }),
      );

      // AI 1,340,000 x 5.0 = 6,700,000 and 2 minutes x 16,000, against a hold of 5,400,000.
      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -5_400_000],
        ["release", 5_400_000],
        ["usage", -6_732_000],
      ]);
      expect((await journalOf(fixture).balance()).balanceMicroUsd).toBe(
        -1_332_000,
      );
      const next = await fixture.enqueueNew({
        prNumber: 901,
        headSha: sha("d"),
        reviewKind: "dynamic",
      });
      expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();
      expect(await fixture.queue.get(next.id)).toMatchObject({
        status: "failed",
        errorCode: "balance_negative",
      });
    },
  );

  // #498-T08
  run(
    "charges the minutes only for a run that ended without a result after it used the model",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, { managed: true });

      // A usage that was sent and cannot be read: the cost is unknown, the model may have been used.
      await fixture.queue.complete(job.id, leaseToken, {
        ok: false,
        errorCode: "review_not_published",
        result: { usage: "unreadable" },
      });

      const entries = await entriesOf(fixture, job.id);
      expect(shape(entries)).toEqual([
        ["reservation", -1_075_000],
        ["release", 1_075_000],
        ["usage", -26_000],
      ]);
      expect(entries[2]).toMatchObject({
        aiMicroUsd: 0,
        infraMicroUsd: 26_000,
      });
    },
  );

  // #498-T08
  run("charges the minutes only when the provider cost is missing", async () => {
    const fixture = await start({ keyMode: "managed" });
    const { job, leaseToken } = await claim(fixture, { managed: true });

    await fixture.queue.complete(job.id, leaseToken, delivered(null));

    expect(shape(await entriesOf(fixture, job.id))).toEqual([
      ["reservation", -1_075_000],
      ["release", 1_075_000],
      ["usage", -26_000],
    ]);
  });

  // #498-T08b
  run(
    "charges the minutes only for an own-key Dynamic run whose cost is unknown",
    async () => {
      const fixture = await start({ keyMode: "own" });
      const { job, leaseToken } = await claim(fixture, { kind: "dynamic" });

      await fixture.queue.complete(job.id, leaseToken, delivered(null));

      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -25 * 16_000],
        ["release", 25 * 16_000],
        ["usage", -32_000],
      ]);
    },
  );

  // #498-T08b
  run(
    "releases the hold of a managed Dynamic run that ended dynamic_accounting_failed and charges nothing",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, {
        kind: "dynamic",
        managed: true,
      });

      await fixture.queue.complete(job.id, leaseToken, {
        ok: false,
        errorCode: "dynamic_accounting_failed",
        result: { usage: { promptTokens: 5, completionTokens: 1, costUsd: null } },
      });

      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -5_400_000],
        ["release", 5_400_000],
      ]);
      expect((await journalOf(fixture).balance()).balanceMicroUsd).toBe(
        100_000_000,
      );
    },
  );

  // #498-T09
  run(
    "charges a superseded run whose Worker reported the AI and the infrastructure part",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, {
        managed: true,
        vmSeconds: null,
        acceptsSupersede: true,
      });
      await startVm(fixture, job, "vm-1");
      fixture.clock.advance(60 * SECOND);
      // A newer push replaces the run while it runs; its Worker drains and reports, and the stop is confirmed 30 s later.
      const newer = await fixture.queue.enqueue({
        repositoryId: job.repositoryId,
        prNumber: job.prNumber,
        prUrl: job.prUrl,
        headSha: sha("e"),
        command: "review",
        triggerKind: "webhook",
        actorLogin: "octocat",
      });
      expect(newer.status).toBe("created");
      fixture.clock.advance(30 * SECOND);
      await vmRunsOf(fixture).confirmStopped(
        job.id,
        ["vm-1"],
        fixture.clock.now(),
      );

      await fixture.queue.complete(job.id, leaseToken, delivered(0.5));

      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "superseded",
      });
      // 90 seconds from the start of the VM to its confirmed stop: 2 minutes.
      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -1_075_000],
        ["release", 1_075_000],
        ["usage", -2_526_000],
      ]);
    },
  );

  // #498-T09
  run(
    "charges a superseded run whose Worker never reported the infrastructure part up to the push plus a minute",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job } = await claim(fixture, {
        managed: true,
        vmSeconds: null,
        acceptsSupersede: true,
      });
      await startVm(fixture, job, "vm-1");
      fixture.clock.advance(60 * SECOND);
      await fixture.queue.enqueue({
        repositoryId: job.repositoryId,
        prNumber: job.prNumber,
        prUrl: job.prUrl,
        headSha: sha("e"),
        command: "review",
        triggerKind: "webhook",
        actorLogin: "octocat",
      });
      // The drain window and the grace for a late report pass without a report.
      fixture.clock.advance(10 * 60 * SECOND);

      await fixture.queue.expireStaleJobs();

      // The backstop is the push plus 60 seconds: 120 seconds from the start, 2 minutes. The AI cost is unknown.
      const entries = await entriesOf(fixture, job.id);
      expect(shape(entries)).toEqual([
        ["reservation", -1_075_000],
        ["release", 1_075_000],
        ["usage", -26_000],
      ]);
      expect(entries[2]).toMatchObject({ aiMicroUsd: 0, minutes: 2 });
    },
  );

  // #498-T10
  run.each(["launch_failed", "worker_exited"])(
    "releases the hold and charges nothing for a job the Dispatcher gave back as %s on its last attempt",
    async (reason) => {
      const fixture = await start({ keyMode: "managed", maxAttempts: 1 });
      const { job, leaseToken } = await claim(fixture, { managed: true });

      await fixture.queue.release(job.id, leaseToken, reason);

      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: reason,
      });
      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -1_075_000],
        ["release", 1_075_000],
      ]);
    },
  );

  // #498-T10
  run(
    "releases the hold and charges nothing when the lease ran out on the last attempt",
    async () => {
      const fixture = await start({ keyMode: "managed", maxAttempts: 1 });
      const { job } = await claim(fixture, { managed: true });
      fixture.clock.advance(5 * 60 * SECOND);

      await fixture.queue.expireStaleJobs();

      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "lease_expired",
      });
      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -1_075_000],
        ["release", 1_075_000],
      ]);
    },
  );

  // #498-T11
  run("takes no hold from a workspace whose claim the entitlements refuse", async () => {
    const fixture = await start();
    await createWorkspaceEntitlementsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ).put(entitlements("own", true), null);
    const job = await fixture.enqueueNew({ prNumber: 5 });

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(await fixture.queue.get(job.id)).toMatchObject({
      errorCode: "workspace_suspended",
    });
    expect(await entriesOf(fixture, job.id)).toEqual([]);
    expect((await journalOf(fixture).balance()).reservedMicroUsd).toBe(0);
  });

  // #498-T11
  run("writes no entry for a job cancelled while it waited", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew({ prNumber: 5 });

    await fixture.queue.cancelWaitingForRepository(fixture.repositoryId);

    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "cancelled",
    });
    expect(await entriesOf(fixture, job.id)).toEqual([]);
  });

  // #498-T11
  run(
    "releases the hold of a job that waited again after a lost attempt and was replaced",
    async () => {
      const fixture = await start();
      const { job, leaseToken } = await claim(fixture);
      expect(
        (await fixture.queue.release(job.id, leaseToken, "worker_exited"))
          .status,
      ).toBe("requeued");
      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -325_000],
      ]);

      await fixture.queue.enqueue({
        repositoryId: job.repositoryId,
        prNumber: job.prNumber,
        prUrl: job.prUrl,
        headSha: sha("f"),
        command: "review",
        triggerKind: "webhook",
        actorLogin: "octocat",
      });

      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "superseded",
      });
      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -325_000],
        ["release", 325_000],
      ]);
    },
  );

  // #498-T12
  run("voids a job refused after the hold and releases the hold", async () => {
    const fixture = await start({ keyMode: "managed" });
    const { job, leaseToken } = await claim(fixture, {
      managed: true,
      vmSeconds: null,
    });

    // The runner API ends a job it cannot give a key with the code and no result.
    await fixture.queue.complete(job.id, leaseToken, {
      ok: false,
      errorCode: "llm_not_configured",
    });

    expect(shape(await entriesOf(fixture, job.id))).toEqual([
      ["reservation", -1_075_000],
      ["release", 1_075_000],
    ]);
    expect(await recordsOf(fixture).get(job.id)).toMatchObject({
      state: "void",
    });
  });

  // #498-T13
  run(
    "writes one usage and one release when the completion is delivered twice and a sweep follows",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, { managed: true });

      const first = await fixture.queue.complete(
        job.id,
        leaseToken,
        delivered(0.5),
      );
      const second = await fixture.queue.complete(
        job.id,
        leaseToken,
        delivered(0.5),
      );
      fixture.clock.advance(60 * 60 * SECOND);
      await fixture.queue.expireStaleJobs();
      await fixture.queue.claimNext("runner-b", ENGINES);

      expect(first.status).toBe("completed");
      expect(second.status).toBe("already_completed");
      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -1_075_000],
        ["release", 1_075_000],
        ["usage", -2_526_000],
      ]);
      expect(await journalOf(fixture).verify()).toMatchObject({
        consistent: true,
      });
    },
  );

  // #498-T06
  run(
    "settles every job it ends, so the balance equals the sum of the entries",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const delivery = await claim(fixture, { managed: true });
      const failure = await claim(fixture, { managed: true });
      await fixture.queue.complete(
        delivery.job.id,
        delivery.leaseToken,
        delivered(0.25),
      );
      await fixture.queue.complete(failure.job.id, failure.leaseToken, {
        ok: false,
        errorCode: "runner_error",
      });

      const reserved = await journalOf(fixture).balance();

      expect(reserved.reservedMicroUsd).toBe(0);
      expect(await journalOf(fixture).verify()).toMatchObject({
        consistent: true,
        reservedMicroUsd: 0,
      });
    },
  );
});
