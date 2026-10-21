// SPDX-License-Identifier: Apache-2.0

// The cron sweep of a hosted deployment (#328) against a real database, the real queue and the stand-in for the
// Dispatcher: lease expiry without any polling runner, the resends, the give-up with `dispatch_unavailable`,
// the pool cap, the revival of a stopped dispatch and the hourly cleanup. On SQLite and, when
// TEST_DATABASE_URL is set, on Postgres (CI).
import { sql, type Kysely } from "kysely";
import { describe, expect, it as vitestIt, vi } from "vitest";
import type { Database } from "../db/schema.ts";
import { createAppMetaRepository } from "../db/repositories/app-meta-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import {
  readJournalCheck,
  runJournalCheckWhileBillingOn,
} from "../billing/journal-check.ts";
import { createJobQueue } from "../jobs/job-queue.ts";
import type { EnqueueJobInput, EnqueueResult } from "../jobs/job-types.ts";
import { createRunnerQueue } from "../jobs/runner-queue.ts";
import {
  accepted,
  createFakeDispatchReceiver,
  ignored,
} from "../test-support/fake-dispatch-receiver.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import type { WebhookDispatchConfig } from "./config.ts";
import { createDispatchService } from "./service.ts";
import {
  createDispatchSweep,
  STOPPED_REVIVE_MS,
  type SweepSettings,
} from "./sweep.ts";

const CURRENT = {
  kid: "k2",
  secret: "example-dispatch-secret-current-00000000",
};
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const webhookConfig: WebhookDispatchConfig = {
  mode: "webhook",
  url: "https://dispatcher.example.test/dispatch",
  currentKey: CURRENT,
};

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

const POOL = "dispatcher";

async function setupOn(
  open: (() => Promise<Kysely<Database>>) | undefined,
  options: {
    settings?: Partial<SweepSettings>;
    /** Poll mode: no dispatch service at all. */
    poll?: boolean;
  } = {},
) {
  const database = await open?.();
  const fixture = await createJobQueueFixture({
    ...(database === undefined ? {} : { database }),
  });
  const receiver = createFakeDispatchReceiver({
    keys: [CURRENT],
    now: fixture.clock.now,
  });
  const logs = { warn: [] as string[], error: [] as string[] };
  const service = createDispatchService({
    db: fixture.db,
    config: webhookConfig,
    fetch: receiver.fetch,
    now: fixture.clock.now,
    timeoutMs: 40,
    // The resends below are driven by the test (`sendDue`); the retries inside the request have their own test.
    inlineRetryDelaysMs: [],
    log: {
      warn: (line) => logs.warn.push(line),
      error: (line) => logs.error.push(line),
    },
  });
  const work: Promise<void>[] = [];
  const jobs = createJobQueue(fixture.db, fixture.workspaceId, {
    now: fixture.clock.now,
    ...(options.poll === true
      ? {}
      : {
          onEnqueued: (result: EnqueueResult) => {
            work.push(service.onEnqueued(result));
          },
        }),
  });
  const runnerQueue = createRunnerQueue(fixture.db, { now: fixture.clock.now });
  const cleanup = vi.fn(async () => ({
    rateLimits: 0,
    unverifiedAccounts: 0,
    verificationTokens: 0,
    passwordResetTokens: 0,
    jobClaimedKeys: 0,
    jobDispatches: 0,
  }));
  const sweepLogs: string[] = [];
  const sweep = createDispatchSweep({
    now: fixture.clock.now,
    queue: runnerQueue,
    dispatches: createJobDispatchesRepository(fixture.db, fixture.clock.now),
    ...(options.poll === true ? {} : { dispatch: service }),
    meta: createAppMetaRepository(fixture.db, fixture.clock.now),
    cleanup,
    // #626: the daily check of the billing journal, the real one.
    journalCheck: {
      run: () =>
        runJournalCheckWhileBillingOn(fixture.db, {
          now: fixture.clock.now,
          log: {
            info: (line) => sweepLogs.push(line),
            error: (line) => sweepLogs.push(line),
          },
        }),
    },
    settings: {
      giveUpMs: options.poll === true ? null : HOUR,
      maxRunning: null,
      ...options.settings,
    },
    log: {
      info: (line) => sweepLogs.push(line),
      error: (line) => sweepLogs.push(line),
    },
  });
  const enqueue = (
    overrides: Partial<EnqueueJobInput> & { prNumber?: number } = {},
  ) => {
    const prNumber = overrides.prNumber ?? 7;
    return jobs.enqueue({
      repositoryId: fixture.repositoryId,
      prNumber,
      prUrl: `https://github.test/acme/widgets/pull/${String(prNumber)}`,
      headSha: sha("a"),
      command: "review",
      triggerKind: "webhook",
      actorLogin: "octocat",
      ...overrides,
    });
  };
  return {
    fixture,
    receiver,
    logs,
    sweepLogs,
    service,
    runnerQueue,
    sweep,
    cleanup,
    enqueue,
    dispatches: createJobDispatchesRepository(fixture.db, fixture.clock.now),
    async settled() {
      await Promise.all(work);
    },
    /** What a Dispatcher does when it was woken: claims exactly that job into its pool. */
    async claim(jobId: string, maxRunning?: number) {
      const claimed = await runnerQueue.claimNext(POOL, ["pr-agent"], {
        jobId,
        workerCredential: true,
        ...(maxRunning === undefined ? {} : { maxRunning }),
      });
      if (claimed === null) throw new Error("The job could not be claimed.");
      return claimed;
    },
    advance(ms: number) {
      fixture.clock.advance(ms);
    },
    async job(id: string) {
      const job = await runnerQueue.get(id);
      if (job === undefined) throw new Error("No such job.");
      return job;
    },
  };
}

describe.each(databases)("the dispatch sweep on %s", (name, open) => {
  const it =
    name === "Postgres" && open === undefined ? vitestIt.skip : vitestIt;
  const setup = (options: Parameters<typeof setupOn>[1] = {}) =>
    setupOn(open, options);

  describe("lease expiry without a polling runner", () => {
    // #328-T01
    it("puts a job whose lease lapsed back in the queue with the attempt counted, and dispatches it again", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      const claimed = await t.claim(job.id);
      expect(t.receiver.received).toHaveLength(1);

      // Nobody heartbeats and nobody polls: the lease (2 minutes) lapses.
      t.advance(3 * MINUTE);
      const report = await t.sweep.run();

      expect(report.expired).toMatchObject({ requeued: 1 });
      expect(await t.job(job.id)).toMatchObject({
        status: "queued",
        attempts: 1,
      });
      expect(report.sent).toBe(1);
      expect(t.receiver.received).toHaveLength(2);
      expect(t.receiver.received[1]?.body).toMatchObject({
        jobId: job.id,
        attempt: 2,
      });
      // The old holder is turned away.
      expect(await t.runnerQueue.heartbeat(job.id, claimed.leaseToken)).toEqual(
        { status: "not_holder" },
      );
    });

    // #328-T01
    it("fails the job on its last allowed attempt instead of queueing it again", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await t.claim(job.id);
        t.advance(3 * MINUTE);
        await t.sweep.run();
      }

      expect(await t.job(job.id)).toMatchObject({
        status: "failed",
        errorCode: "lease_expired",
      });
    });

    // #328-T02
    it("fails a job that runs past the 25 minute limit with `timeout`, however well it heartbeats", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      const claimed = await t.claim(job.id);
      for (let minute = 0; minute < 24; minute += 1) {
        t.advance(MINUTE);
        expect(
          await t.runnerQueue.heartbeat(job.id, claimed.leaseToken),
        ).toMatchObject({
          status: "ok",
        });
      }
      t.advance(90 * SECOND);

      const report = await t.sweep.run();

      expect(report.expired).toMatchObject({ timedOut: 1 });
      expect(await t.job(job.id)).toMatchObject({
        status: "failed",
        errorCode: "timeout",
      });
    });
  });

  describe("jobs that are not due yet", () => {
    // #328-T03
    it("dispatches a job that became due with the next run, and not before", async () => {
      const t = await setup();
      const runAfter = new Date(t.fixture.clock.now().getTime() + 90 * SECOND);
      const { job } = await t.enqueue({ runAfter });
      await t.settled();
      expect(t.receiver.received).toHaveLength(0);

      t.advance(60 * SECOND);
      expect((await t.sweep.run()).sent).toBe(0);
      expect(t.receiver.received).toHaveLength(0);

      t.advance(30 * SECOND);
      expect((await t.sweep.run()).sent).toBe(1);
      expect(t.receiver.received.map((call) => call.body?.jobId)).toEqual([
        job.id,
      ]);
    });
  });

  describe("the give-up", () => {
    const unreachable = (t: Awaited<ReturnType<typeof setup>>) =>
      t.receiver.reply(...Array.from({ length: 200 }, () => ({ status: 503 })));

    // #328-T04
    it("fails a job that was due for an hour without a claim with `dispatch_unavailable`, and frees the pull request", async () => {
      const t = await setup();
      unreachable(t);
      const { job } = await t.enqueue();
      await t.settled();

      // Every minute of the hour: the Dispatcher stays away, and the job waits.
      for (let minute = 1; minute < 60; minute += 1) {
        t.advance(MINUTE);
        await t.sweep.run();
      }
      t.advance(59 * SECOND);
      expect((await t.sweep.run()).givenUp).toBe(0);
      expect((await t.job(job.id)).status).toBe("queued");

      t.advance(SECOND);
      const report = await t.sweep.run();

      expect(report.givenUp).toBe(1);
      expect(await t.job(job.id)).toMatchObject({
        status: "failed",
        errorCode: "dispatch_unavailable",
        finishedAt: t.fixture.clock.now().toISOString(),
      });
      // The slot of the pull request is free: the next push creates a new job.
      const next = await t.enqueue({ headSha: sha("b") });
      expect(next.status).toBe("created");
      // A failed job is not sent again.
      const before = t.receiver.received.length;
      t.advance(HOUR);
      await t.sweep.run();
      expect(
        t.receiver.received
          .slice(before)
          .some((call) => call.body?.jobId === job.id),
      ).toBe(false);
    });

    // #328-T05
    it("does not fail a job a Dispatcher claimed in time, however long it then runs", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      t.advance(30 * MINUTE);
      const claimed = await t.claim(job.id);
      for (let minute = 0; minute < 24; minute += 1) {
        t.advance(MINUTE);
        await t.runnerQueue.heartbeat(job.id, claimed.leaseToken);
      }

      const report = await t.sweep.run();

      expect(report.givenUp).toBe(0);
      expect((await t.job(job.id)).status).toBe("running");
    });

    // #328-T05
    it("counts the wait from when the job was queued again, not from when it was first due", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      t.advance(40 * MINUTE);
      await t.claim(job.id);
      // The Dispatcher dies; the lease lapses; the job is queued again at minute 43.
      t.advance(3 * MINUTE);
      await t.sweep.run();
      expect((await t.job(job.id)).status).toBe("queued");

      // Minute 61: due for 61 minutes since the beginning, but only for 18 since it was queued again.
      t.advance(18 * MINUTE);
      const report = await t.sweep.run();

      expect(report.givenUp).toBe(0);
      expect((await t.job(job.id)).status).toBe("queued");
    });

    // #328-T05
    it("does not fail a job whose dispatch a Dispatcher acknowledged a moment ago", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      // The Dispatcher took the call 119 seconds ago and has not claimed yet; nothing else happened for an hour.
      t.advance(HOUR + 2 * MINUTE);
      await t.dispatches.record(
        job.id,
        {
          state: "acked",
          consecutiveFailures: 0,
          nextDispatchAt: new Date(t.fixture.clock.now().getTime() + SECOND),
          lastStatus: 202,
          lastCode: "accepted",
          acknowledged: true,
          alert: false,
        },
        t.fixture.clock.now(),
      );

      const report = await t.sweep.run();

      expect(report.givenUp).toBe(0);
      expect((await t.job(job.id)).status).toBe("queued");
    });

    // #328-T09
    it("is off in poll mode without the setting: a job that waits for hours is left alone and nothing is sent", async () => {
      const t = await setup({ poll: true });
      const { job } = await t.enqueue();
      t.advance(5 * HOUR);

      const report = await t.sweep.run();

      expect(report).toMatchObject({ givenUp: 0, sent: 0, revived: 0 });
      expect((await t.job(job.id)).status).toBe("queued");
      expect(t.receiver.received).toHaveLength(0);
      expect(
        await t.fixture.db.selectFrom("job_dispatches").selectAll().execute(),
      ).toEqual([]);
    });

    // #328-T09
    it("still expires a lapsed lease in poll mode", async () => {
      const t = await setup({ poll: true });
      const { job } = await t.enqueue();
      await t.claim(job.id);
      t.advance(3 * MINUTE);

      const report = await t.sweep.run();

      expect(report.expired).toMatchObject({ requeued: 1 });
      expect((await t.job(job.id)).status).toBe("queued");
    });

    // #328-T09
    it("applies in poll mode when the operator sets it", async () => {
      const t = await setup({
        poll: true,
        settings: { giveUpMs: 30 * MINUTE },
      });
      const { job } = await t.enqueue();
      t.advance(31 * MINUTE);

      await t.sweep.run();

      expect(await t.job(job.id)).toMatchObject({
        status: "failed",
        errorCode: "dispatch_unavailable",
      });
    });
  });

  describe("the pool cap", () => {
    // #328-T08
    it("sends nothing while the cap is reached, and sends the job when a slot frees", async () => {
      const t = await setup({ settings: { maxRunning: 1 } });
      t.receiver.reply(accepted, ignored("not_claimable"));
      const first = await t.enqueue({ prNumber: 1 });
      const second = await t.enqueue({ prNumber: 2 });
      await t.settled();
      const claimed = await t.claim(first.job.id, 1);
      // The second call found the pool full.
      expect(t.receiver.received).toHaveLength(2);

      // Two minutes on, the second is due again, but the one slot is taken.
      t.advance(2 * MINUTE);
      await t.runnerQueue.heartbeat(first.job.id, claimed.leaseToken);
      const full = await t.sweep.run();
      expect(full.sent).toBe(0);
      expect(t.receiver.received).toHaveLength(2);

      // The first review ends: the slot is free and the next run sends the second job.
      await t.runnerQueue.complete(first.job.id, claimed.leaseToken, {
        ok: true,
        result: {},
      });
      const free = await t.sweep.run();
      expect(free.sent).toBe(1);
      expect(t.receiver.received.map((call) => call.body?.jobId)).toEqual([
        first.job.id,
        second.job.id,
        second.job.id,
      ]);
    });

    // #328-T08
    it("sends only as many jobs as there are free slots", async () => {
      const t = await setup({ settings: { maxRunning: 2 } });
      t.receiver.reply(
        accepted,
        ...Array.from({ length: 3 }, () => ignored("not_claimable")),
      );
      const first = await t.enqueue({ prNumber: 1 });
      await t.enqueue({ prNumber: 2 });
      await t.enqueue({ prNumber: 3 });
      await t.enqueue({ prNumber: 4 });
      await t.settled();
      const claimed = await t.claim(first.job.id, 2);
      const sentBefore = t.receiver.received.length;
      t.advance(2 * MINUTE);
      await t.runnerQueue.heartbeat(first.job.id, claimed.leaseToken);

      const report = await t.sweep.run();

      expect(report.sent).toBe(1);
      expect(t.receiver.received).toHaveLength(sentBefore + 1);
    });
  });

  describe("a dispatch that stopped", () => {
    // #328-T03
    it("is looked at again after a while, because the Dispatcher may have been updated", async () => {
      const t = await setup();
      t.receiver.reply(ignored("not_capable"), accepted);
      const { job } = await t.enqueue();
      await t.settled();
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "stopped",
      });

      t.advance(STOPPED_REVIVE_MS - SECOND);
      expect(await t.sweep.run()).toMatchObject({ revived: 0, sent: 0 });
      expect(t.receiver.received).toHaveLength(1);

      t.advance(SECOND);
      expect(await t.sweep.run()).toMatchObject({ revived: 1, sent: 1 });
      expect(t.receiver.received).toHaveLength(2);
      expect(await t.dispatches.get(job.id)).toMatchObject({ state: "acked" });
    });

    // #328-T03
    it("is not revived for a job that is no longer waiting", async () => {
      const t = await setup();
      t.receiver.reply(ignored("not_capable"));
      const { job } = await t.enqueue();
      await t.settled();
      await t.fixture.db
        .updateTable("jobs")
        .set({ status: "cancelled" })
        .where("id", "=", job.id)
        .execute();

      t.advance(STOPPED_REVIVE_MS);
      const report = await t.sweep.run();

      expect(report).toMatchObject({ revived: 0, sent: 0 });
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "stopped",
      });
    });

    // #328-T03
    it("asks again at the same pace while the Dispatcher stays unable, and never hot", async () => {
      const t = await setup();
      t.receiver.reply(
        ...Array.from({ length: 20 }, () => ignored("not_capable")),
      );
      await t.enqueue();
      await t.settled();

      for (let minute = 0; minute < 31; minute += 1) {
        t.advance(MINUTE);
        await t.sweep.run();
      }

      // The first call, and one more every ten minutes.
      expect(t.receiver.received).toHaveLength(4);
    });
  });

  describe("the hourly cleanup", () => {
    // #328-T11
    it("runs once in an hour, not at every run, and again when the hour changes", async () => {
      const t = await setup();
      // The fixture clock starts at 12:00:00.
      t.advance(30 * SECOND);
      await t.sweep.run();
      for (let minute = 1; minute < 60; minute += 1) {
        t.advance(MINUTE);
        await t.sweep.run();
      }
      // 12:59:30
      expect(t.cleanup).toHaveBeenCalledTimes(1);

      // 13:00:30
      t.advance(MINUTE);
      await t.sweep.run();
      await t.sweep.run();

      expect(t.cleanup).toHaveBeenCalledTimes(2);
    });

    // #328-T11
    it("is tried again at the next run when it failed, and the sweep goes on without it", async () => {
      const t = await setup();
      t.cleanup.mockRejectedValueOnce(new Error("the database said no"));
      const { job } = await t.enqueue();
      await t.settled();
      t.advance(3 * MINUTE);

      const failed = await t.sweep.run();
      t.advance(MINUTE);
      const retried = await t.sweep.run();

      expect(failed.failedSteps).toEqual(["cleanup"]);
      expect(retried.failedSteps).toEqual([]);
      expect(t.cleanup).toHaveBeenCalledTimes(2);
      // The cause is never repeated.
      expect(t.sweepLogs.join("\n")).not.toContain("the database said no");
      expect((await t.job(job.id)).status).toBe("queued");
    });
  });

  describe("the check of the billing journal (#626)", () => {
    // #626-T15
    it("does nothing while billing is off, and nothing is recorded", async () => {
      const t = await setup();
      await fundWorkspace(t.fixture.db, t.fixture.workspaceId, 5_000_000);

      const report = await t.sweep.run();

      expect(report.journalChecked).toBe(0);
      expect(report.failedSteps).toEqual([]);
      expect(await readJournalCheck(t.fixture.db)).toMatchObject({
        state: "never",
      });
    });

    // #626-T15
    it("checks the journal while billing is on, shows an inconsistency on the admin overview's data, and checks again only a day later", async () => {
      const t = await setup();
      await setBillingSwitch(t.fixture.db, true);
      await fundWorkspace(t.fixture.db, t.fixture.workspaceId, 5_000_000);
      await sql`update billing_balances set balance_micro_usd = balance_micro_usd + 3 where workspace_id = ${t.fixture.workspaceId}`.execute(
        t.fixture.db,
      );

      const first = await t.sweep.run();
      t.advance(MINUTE);
      const second = await t.sweep.run();
      t.advance(24 * HOUR);
      const third = await t.sweep.run();

      expect(first.journalChecked).toBe(1);
      expect(second.journalChecked).toBe(0);
      expect(third.journalChecked).toBe(1);
      expect(await readJournalCheck(t.fixture.db)).toMatchObject({
        state: "inconsistent",
        workspaces: 1,
        inconsistentWorkspaces: 1,
      });
      expect(
        t.sweepLogs.filter((line) =>
          line.includes("BILLING_JOURNAL_INCONSISTENT"),
        ),
      ).toHaveLength(2);
    });
  });
});
