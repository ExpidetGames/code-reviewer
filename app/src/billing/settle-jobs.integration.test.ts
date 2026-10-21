// SPDX-License-Identifier: Apache-2.0

// The settlement of a job (#498, reworked by #605; ADR 0006, 2.6 and 2.8): no amount is held at the claim, so in the
// transaction that ends the job the journal gets one `usage` entry with the AI and infrastructure parts, unless the outcome
// is free or prices to nothing, and the balance may go below zero. A job that holds an old reservation (written before #605)
// is still settled with a release and the usage. On SQLite and, when TEST_DATABASE_URL is set, on Postgres. Made-up rates
// (test-support/billing-switch.ts): A = 5.0, B(Diff) = 13,000, B(Dynamic) = 16,000 micro-USD a minute. A run whose VM lived
// 90 seconds is 2 started minutes.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createBillingJournalRepository,
  type JournalEntry,
} from "../db/repositories/billing-journal-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import { decideOutcome } from "../dispatch/outcome.ts";
import { settleEndedJobs } from "./settle-jobs.ts";
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

describe.each(databases)("the settlement of a job without a hold on %s", (name, open) => {
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

  const billingStateOf = async (fixture: JobQueueFixture, jobId: string) =>
    (
      await fixture.db
        .selectFrom("usage_records")
        .select("billing_state")
        .where("job_id", "=", jobId)
        .executeTakeFirstOrThrow()
    ).billing_state;

  const shape = (entries: JournalEntry[]) =>
    entries.map((entry) => [entry.type, entry.amountMicroUsd]);

  // #498-T06
  run(
    "charges the AI and the infrastructure part of a delivered result with a known cost, and writes nothing else",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, { managed: true });

      await fixture.queue.complete(job.id, leaseToken, delivered(0.5));

      const entries = await entriesOf(fixture, job.id);
      // The price is 500,000 x 5.0 for the AI and 2 x 13,000 for the minutes.
      expect(shape(entries)).toEqual([
        ["usage", -2_526_000],
      ]);
      expect(entries[0]).toMatchObject({
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
      expect(await billingStateOf(fixture, job.id)).toBe("settled");
    },
  );

  // #498-T20
  run(
    "charges only the infrastructure part of a delivered result with a known cost on the workspace's own key",
    async () => {
      const fixture = await start({ keyMode: "own" });
      const { job, leaseToken } = await claim(fixture);

      await fixture.queue.complete(job.id, leaseToken, delivered(0.5));

      const entries = await entriesOf(fixture, job.id);
      // The AI cost is the customer's own and costs them nothing here.
      expect(shape(entries)).toEqual([
        ["usage", -26_000],
      ]);
      expect(entries[0]).toMatchObject({
        aiMicroUsd: 0,
        infraMicroUsd: 26_000,
        minutes: 2,
      });
      expect((await journalOf(fixture).balance()).balanceMicroUsd).toBe(
        100_000_000 - 26_000,
      );
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
  // #605-T07
  run(
    "charges the full price of a Diff run above the balance, takes the balance below zero and refuses the next claim",
    async () => {
      const fixture = await start({ keyMode: "managed", funding: 1_075_000 });
      const { job, leaseToken } = await claim(fixture, { managed: true });

      await fixture.queue.complete(job.id, leaseToken, delivered(2));

      // AI 2,000,000 x 5.0 = 10,000,000 and 2 minutes x 13,000.
      expect(shape(await entriesOf(fixture, job.id))).toEqual([
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
  // #605-T07
  run(
    "charges the full price of a Dynamic run above the balance (usage.limitExceededBy), and refuses the next claim",
    async () => {
      const fixture = await start({ keyMode: "managed", funding: 5_400_000 });
      const { job, leaseToken } = await claim(fixture, {
        kind: "dynamic",
        managed: true,
      });
      // Nothing was held: the claim left the whole balance.
      expect((await journalOf(fixture).balance()).balanceMicroUsd).toBe(
        5_400_000,
      );

      await fixture.queue.complete(
        job.id,
        leaseToken,
        delivered(1.34, { limitExceededBy: 0.34 }),
      );

      // AI 1,340,000 x 5.0 = 6,700,000 and 2 minutes x 16,000, against a balance of 5,400,000.
      expect(shape(await entriesOf(fixture, job.id))).toEqual([
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
        ["usage", -26_000],
      ]);
      expect(entries[0]).toMatchObject({
        aiMicroUsd: 0,
        infraMicroUsd: 26_000,
      });
    },
  );

  // #498-T08
  run(
    "charges the minutes only when the provider cost is missing",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, { managed: true });

      await fixture.queue.complete(job.id, leaseToken, delivered(null));

      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["usage", -26_000],
      ]);
    },
  );

  // #498-T08b
  run(
    "charges the minutes only for an own-key Dynamic run whose cost is unknown",
    async () => {
      const fixture = await start({ keyMode: "own" });
      const { job, leaseToken } = await claim(fixture, { kind: "dynamic" });

      await fixture.queue.complete(job.id, leaseToken, delivered(null));

      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["usage", -32_000],
      ]);
    },
  );

  // #498-T08b
  run(
    "charges nothing for a managed Dynamic run that ended dynamic_accounting_failed",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, {
        kind: "dynamic",
        managed: true,
      });

      await fixture.queue.complete(job.id, leaseToken, {
        ok: false,
        errorCode: "dynamic_accounting_failed",
        result: {
          usage: { promptTokens: 5, completionTokens: 1, costUsd: null },
        },
      });

      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
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
        ["usage", -26_000],
      ]);
      expect(entries[0]).toMatchObject({ aiMicroUsd: 0, minutes: 2 });
    },
  );

  // #498-T10
  run.each(["launch_failed", "worker_exited"])(
    "charges nothing for a job the Dispatcher gave back as %s on its last attempt",
    async (reason) => {
      const fixture = await start({ keyMode: "managed", maxAttempts: 1 });
      const { job, leaseToken } = await claim(fixture, { managed: true });

      await fixture.queue.release(job.id, leaseToken, reason);

      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: reason,
      });
      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
    },
  );

  // #498-T10
  run(
    "charges nothing when the lease ran out on the last attempt",
    async () => {
      const fixture = await start({ keyMode: "managed", maxAttempts: 1 });
      const { job } = await claim(fixture, { managed: true });
      fixture.clock.advance(5 * 60 * SECOND);

      await fixture.queue.expireStaleJobs();

      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "lease_expired",
      });
      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
    },
  );

  // #498-T11
  run(
    "writes no entry for a workspace whose claim the entitlements refuse",
    async () => {
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
    },
  );

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
    "charges nothing for a job that waited again after a lost attempt and was replaced, and closes its billing",
    async () => {
      const fixture = await start();
      const { job, leaseToken } = await claim(fixture);
      expect(
        (await fixture.queue.release(job.id, leaseToken, "worker_exited"))
          .status,
      ).toBe("requeued");
      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);

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
      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
      expect(await billingStateOf(fixture, job.id)).toBe("settled");
    },
  );

  // #498-T21
  run(
    "charges nothing for a job that waited again after a lost attempt and was cancelled, and leaves the balance",
    async () => {
      const fixture = await start();
      const { job, leaseToken } = await claim(fixture);
      await fixture.queue.release(job.id, leaseToken, "worker_exited");
      expect(await journalOf(fixture).balance()).toEqual({
        balanceMicroUsd: 100_000_000,
        reservedMicroUsd: 0,
      });

      expect(
        await fixture.queue.cancelWaitingForRepository(fixture.repositoryId),
      ).toBe(1);

      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "cancelled",
      });
      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
      expect(await journalOf(fixture).balance()).toEqual({
        balanceMicroUsd: 100_000_000,
        reservedMicroUsd: 0,
      });
    },
  );

  // #498-T12
  run("voids a job refused after the claim and charges nothing", async () => {
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

    expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
    expect(await recordsOf(fixture).get(job.id)).toMatchObject({
      state: "void",
    });
  });

  // #498-T13
  run(
    "writes one usage when the completion is delivered twice and a sweep follows",
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

  /** A Dispatcher acknowledged the job: it is a hosted job, whose VM the App should have heard of. */
  async function acknowledge(fixture: JobQueueFixture, jobId: string) {
    const dispatches = createJobDispatchesRepository(
      fixture.db,
      fixture.clock.now,
    );
    const at = fixture.clock.now();
    await dispatches.create(jobId, at);
    const row = await dispatches.get(jobId);
    await dispatches.claimSend(jobId, row?.nextDispatchAt ?? "", at);
    await dispatches.record(
      jobId,
      decideOutcome({ kind: "accepted" }, 0, at),
      at,
    );
  }

  // #498-B1 (the gate of the review of #524)
  run(
    "bills the claim wall clock of a hosted job that ran and whose VM was never reported, and flags it",
    async () => {
      const fixture = await start();
      const { job, leaseToken } = await claim(fixture, { vmSeconds: null });
      await acknowledge(fixture, job.id);
      fixture.clock.advance(3 * 60 * SECOND);

      await fixture.queue.complete(job.id, leaseToken, delivered(null));

      const entries = await entriesOf(fixture, job.id);
      expect(shape(entries)).toEqual([
        ["usage", -39_000],
      ]);
      expect(entries[0]).toMatchObject({ minutes: 3 });
      expect(await vmRunsOf(fixture).list(job.id)).toEqual([
        expect.objectContaining({
          endSource: "claim_wall_clock",
          billable: true,
          billableMinutes: 3,
        }),
      ]);
    },
  );

  // #498-B1
  run(
    "bills the wall clock of a job on a self-hosted runner as such, in the transaction that ends it",
    async () => {
      const fixture = await start();
      const { job, leaseToken } = await claim(fixture, { vmSeconds: null });
      fixture.clock.advance(3 * 60 * SECOND);

      await fixture.queue.complete(job.id, leaseToken, delivered(null));

      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["usage", -39_000],
      ]);
      expect((await vmRunsOf(fixture).list(job.id))[0]).toMatchObject({
        endSource: "job_wall_clock",
      });
    },
  );

  // #498-B1 (c: cancelled during the launch, the report is refused)
  run(
    "bills a started minute for a job that was cancelled during its launch, before any VM was reported",
    async () => {
      const fixture = await start();
      const { job, leaseToken } = await claim(fixture, { vmSeconds: null });
      await acknowledge(fixture, job.id);
      fixture.clock.advance(10 * SECOND);

      await fixture.queue.cancelClaimed(
        job.id,
        leaseToken,
        "project_deactivated",
      );

      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["usage", -13_000],
      ]);
    },
  );

  // #498-B1
  run(
    "measures nothing for an outcome that is free, and so makes no wall clock row",
    async () => {
      const fixture = await start({ maxAttempts: 1 });
      const { job, leaseToken } = await claim(fixture, { vmSeconds: null });
      await acknowledge(fixture, job.id);

      await fixture.queue.release(job.id, leaseToken, "launch_failed");

      expect(await vmRunsOf(fixture).list(job.id)).toEqual([]);
      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
    },
  );

  /**
   * A run a newer push replaces while it runs: claimed on a runner that accepts it, its VM started and stopped 90 seconds
   * later (2 started minutes), and the job superseded. The Worker still holds the lease and may report.
   */
  async function supersededRun(fixture: JobQueueFixture, managed: boolean) {
    const { job, leaseToken } = await claim(fixture, {
      managed,
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
    fixture.clock.advance(30 * SECOND);
    await vmRunsOf(fixture).confirmStopped(
      job.id,
      ["vm-1"],
      fixture.clock.now(),
    );
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "superseded",
    });
    return { job, leaseToken };
  }

  // #605-T10 (decision of #489, comment 6310423523: our error wins over superseded-is-charged)
  run.each(["runner_error", "invalid_job", "git_unavailable"])(
    "charges nothing for a superseded run whose Worker reports our error %s",
    async (errorCode) => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await supersededRun(fixture, true);

      const completed = await fixture.queue.complete(job.id, leaseToken, {
        ok: false,
        errorCode,
        result: {
          usage: { promptTokens: 5, completionTokens: 1, costUsd: 0.5 },
        },
      });

      expect(completed.status).toBe("completed");
      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
      expect(await billingStateOf(fixture, job.id)).toBe("settled");
      expect((await journalOf(fixture).balance()).balanceMicroUsd).toBe(
        100_000_000,
      );
    },
  );

  // #605-T10
  run(
    "charges nothing for a superseded run on the operator's key whose Worker reports a provider failure, which is ours there",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await supersededRun(fixture, true);

      await fixture.queue.complete(job.id, leaseToken, {
        ok: false,
        errorCode: "llm_unavailable",
      });

      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
    },
  );

  // #605-T10
  run(
    "still charges a superseded run whose Worker reports a failure that is not ours, and one that reports a result",
    async () => {
      const own = await start({ keyMode: "own" });
      const failed = await supersededRun(own, false);
      await own.queue.complete(failed.job.id, failed.leaseToken, {
        ok: false,
        errorCode: "llm_unavailable",
      });
      // The provider failure is the customer's on their own key: the minutes, 2 x 13,000.
      expect(shape(await entriesOf(own, failed.job.id))).toEqual([
        ["usage", -26_000],
      ]);

      const managed = await start({ keyMode: "managed" });
      const delivered05 = await supersededRun(managed, true);
      await managed.queue.complete(
        delivered05.job.id,
        delivered05.leaseToken,
        delivered(0.5),
      );
      expect(shape(await entriesOf(managed, delivered05.job.id))).toEqual([
        ["usage", -2_526_000],
      ]);
    },
  );

  // #605-T11
  run(
    "does not charge a job that was claimed with billing off and ended with billing on",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      await setBillingSwitch(fixture.db, false);
      const { job, leaseToken } = await claim(fixture, { managed: true });
      await setBillingSwitch(fixture.db, true);

      await fixture.queue.complete(job.id, leaseToken, delivered(0.5));

      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
      expect(await billingStateOf(fixture, job.id)).toBeNull();
      expect((await journalOf(fixture).balance()).balanceMicroUsd).toBe(
        100_000_000,
      );
    },
  );

  // #605-T12
  run(
    "does not charge a job that ended while billing was off, also after billing is switched on again and swept",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, { managed: true });
      await setBillingSwitch(fixture.db, false);

      await fixture.queue.complete(job.id, leaseToken, delivered(0.5));
      await setBillingSwitch(fixture.db, true);
      fixture.clock.advance(60 * 60 * SECOND);
      await fixture.queue.expireStaleJobs();
      await fixture.queue.claimNext("runner-b", ENGINES);

      expect(shape(await entriesOf(fixture, job.id))).toEqual([]);
      expect((await journalOf(fixture).balance()).balanceMicroUsd).toBe(
        100_000_000,
      );
    },
  );

  // #605-T13
  run(
    "charges a job once when its settlement is called twice at the same moment",
    async () => {
      const fixture = await start({ keyMode: "managed" });
      const { job, leaseToken } = await claim(fixture, { managed: true });
      // It ended while billing was off, so nothing settled it; billing is back on and two callers settle it at once.
      await setBillingSwitch(fixture.db, false);
      await fixture.queue.complete(job.id, leaseToken, delivered(0.5));
      await setBillingSwitch(fixture.db, true);
      expect(await billingStateOf(fixture, job.id)).toBe("open");

      await Promise.all([
        fixture.db
          .transaction()
          .execute((trx) =>
            settleEndedJobs(trx, [job.id], fixture.clock.now),
          ),
        fixture.db
          .transaction()
          .execute((trx) =>
            settleEndedJobs(trx, [job.id], fixture.clock.now),
          ),
      ]);

      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["usage", -2_526_000],
      ]);
      expect(await billingStateOf(fixture, job.id)).toBe("settled");
      expect(await journalOf(fixture).verify()).toMatchObject({
        consistent: true,
        balanceMicroUsd: 100_000_000 - 2_526_000,
      });
    },
  );

  // #605-T14 (old rows: an instance that took holds before #605)
  run(
    "settles a job that holds an old reservation with a release and the usage, as before",
    async () => {
      const fixture = await start({ keyMode: "own" });
      const { job, leaseToken } = await claim(fixture);
      // What the claim of an earlier release wrote.
      expect(await journalOf(fixture).reserve(325_000, job.id)).toMatchObject({
        ok: true,
      });

      await fixture.queue.complete(job.id, leaseToken, delivered(0.5));

      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -325_000],
        ["release", 325_000],
        ["usage", -26_000],
      ]);
      expect(await journalOf(fixture).balance()).toEqual({
        balanceMicroUsd: 100_000_000 - 26_000,
        reservedMicroUsd: 0,
      });
      expect(await journalOf(fixture).verify()).toMatchObject({
        consistent: true,
      });
    },
  );

  // #605-T14
  run(
    "releases an old reservation of a job that ended free",
    async () => {
      const fixture = await start({ maxAttempts: 1 });
      const { job, leaseToken } = await claim(fixture);
      await journalOf(fixture).reserve(325_000, job.id);

      await fixture.queue.release(job.id, leaseToken, "launch_failed");

      expect(shape(await entriesOf(fixture, job.id))).toEqual([
        ["reservation", -325_000],
        ["release", 325_000],
      ]);
      expect((await journalOf(fixture).balance()).reservedMicroUsd).toBe(0);
    },
  );
});
