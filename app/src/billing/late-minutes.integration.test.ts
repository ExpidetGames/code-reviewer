// SPDX-License-Identifier: Apache-2.0

// Late minutes (#498; ADR 0006, 2.8 step 5): a job settles with the best end of its VM that it knows. If the App's stop call is
// answered afterwards, within a day, with an end that is more than a minute away from what the settlement used, the journal
// gets one `correction` for the difference; otherwise the settlement stands. On SQLite and, when TEST_DATABASE_URL is set,
// on Postgres. Made-up rates: B(Diff) = 13,000 micro-USD a started minute.
import type { Kysely } from "kysely";
import { describe, expect, it as vitestIt } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import type { Database } from "../db/schema.ts";
import type { WebhookDispatchConfig } from "../dispatch/config.ts";
import { decideOutcome } from "../dispatch/outcome.ts";
import { createStopService } from "../dispatch/stop.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createFakeDispatchReceiver } from "../test-support/fake-dispatch-receiver.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { correctLateMinutes } from "./late-minutes.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const CURRENT = {
  kid: "k2",
  secret: "example-dispatch-secret-current-00000000",
};
const webhookConfig: WebhookDispatchConfig = {
  mode: "webhook",
  url: "https://dispatcher.example.test/dispatch",
  currentKey: CURRENT,
  previousKey: { kid: "k1", secret: "example-dispatch-secret-previous-0000000" },
};
const VM = "cr-diff-job-ab12cd34";
const stoppingVms = (...vms: unknown[]) => ({
  status: 202,
  body: JSON.stringify({ version: 1, status: "stopping", vms }),
});

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

describe.each(databases)("the late minutes of a job on %s", (name, open) => {
  const it =
    name === "Postgres" && open === undefined ? vitestIt.skip : vitestIt;

  async function setup() {
    const database = await open?.();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
    });
    await setBillingSwitch(fixture.db, true);
    await fundWorkspace(fixture.db, fixture.workspaceId, 10_000_000);
    const receiver = createFakeDispatchReceiver({
      keys: [CURRENT],
      now: fixture.clock.now,
    });
    const service = createStopService({
      db: fixture.db,
      config: webhookConfig,
      fetch: receiver.fetch,
      now: fixture.clock.now,
      timeoutMs: 40,
      sleep: () => Promise.resolve(),
      log: { warn: () => undefined },
    });
    const journal = createBillingJournalRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    const runs = createJobVmRunsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    /**
     * A job a Dispatcher acknowledged, claimed on the workspace's own key, with a VM reported two seconds later that ran for a
     * minute and was completed: it settles with the backstop (the job's end plus 60 s), which is 2 started minutes.
     */
    async function settledJob() {
      const job = await fixture.enqueueNew({ prNumber: 7 });
      const dispatches = createJobDispatchesRepository(
        fixture.db,
        fixture.clock.now,
      );
      const at = fixture.clock.now();
      await dispatches.create(job.id, at);
      const row = await dispatches.get(job.id);
      await dispatches.claimSend(job.id, row?.nextDispatchAt ?? "", at);
      await dispatches.record(
        job.id,
        decideOutcome({ kind: "accepted" }, 0, at),
        at,
      );
      const claimed = await fixture.queue.claimNext("pool-a");
      fixture.clock.advance(2 * SECOND);
      await runs.recordStart({
        jobId: job.id,
        vmName: VM,
        claimedAt: claimed?.job.claimedAt as string,
        attempt: 1,
        startedAt: fixture.clock.now(),
        vmTimeoutSeconds: 2100,
      });
      fixture.clock.advance(MINUTE);
      await fixture.queue.complete(job.id, claimed?.leaseToken as string, {
        ok: true,
        result: {},
      });
      return job.id;
    }
    async function entries(jobId: string) {
      const page = await journal.entries({ limit: 50 });
      return page.entries
        .filter((entry) => entry.jobId === jobId)
        .reverse()
        .map((entry) => [entry.type, entry.amountMicroUsd, entry.minutes]);
    }
    return { fixture, receiver, service, journal, runs, settledJob, entries };
  }

  // #498-T14
  it("writes one correction when the real end arrives within a day and is more than a minute away", async () => {
    const t = await setup();
    const id = await t.settledJob();
    expect(await t.entries(id)).toEqual([
      ["reservation", -325_000, null],
      ["release", 325_000, null],
      ["usage", -26_000, 2],
    ]);
    // The answer to the stop call comes ten minutes after the job ended: the VM was up for 11 minutes.
    t.fixture.clock.advance(10 * MINUTE);
    t.receiver.reply(stoppingVms(VM));

    await t.service.stopJobs([id]);

    expect(await t.entries(id)).toEqual([
      ["reservation", -325_000, null],
      ["release", 325_000, null],
      ["usage", -26_000, 2],
      // 9 more started minutes x 13,000.
      ["correction", -117_000, 11],
    ]);
    expect(await t.journal.verify()).toMatchObject({ consistent: true });
  });

  // #498-T14
  it("writes no correction when the end is within a minute of the settlement", async () => {
    const t = await setup();
    const id = await t.settledJob();
    t.fixture.clock.advance(20 * SECOND);
    t.receiver.reply(stoppingVms(VM));

    await t.service.stopJobs([id]);

    expect(await t.entries(id)).toEqual([
      ["reservation", -325_000, null],
      ["release", 325_000, null],
      ["usage", -26_000, 2],
    ]);
  });

  // #498-T14
  it("writes no correction when the real end arrives more than a day after the settlement", async () => {
    const t = await setup();
    const id = await t.settledJob();
    t.fixture.clock.advance(25 * HOUR);
    t.receiver.reply(stoppingVms(VM));

    await t.service.stopJobs([id]);

    expect((await t.entries(id)).map(([type]) => type)).toEqual([
      "reservation",
      "release",
      "usage",
    ]);
  });

  // #498-T14
  it("writes the correction once, however often the end is learned", async () => {
    const t = await setup();
    const id = await t.settledJob();
    t.fixture.clock.advance(10 * MINUTE);
    t.receiver.reply(stoppingVms(VM));
    await t.service.stopJobs([id]);

    await t.service.stopJobs([id]);
    await correctLateMinutes(t.fixture.db, t.fixture.workspaceId, id, t.fixture.clock.now);
    await correctLateMinutes(t.fixture.db, t.fixture.workspaceId, id, t.fixture.clock.now);

    expect(
      (await t.entries(id)).filter(([type]) => type === "correction"),
    ).toHaveLength(1);
  });

  // #498-T14
  it("does nothing for a job that was never billed, and while billing is off", async () => {
    const t = await setup();
    const id = await t.settledJob();
    t.fixture.clock.advance(10 * MINUTE);
    await t.runs.confirmStopped(id, [VM], t.fixture.clock.now());
    await setBillingSwitch(t.fixture.db, false);

    expect(
      await correctLateMinutes(t.fixture.db, t.fixture.workspaceId, id, t.fixture.clock.now),
    ).toBe("billing_off");
    expect(
      (await t.entries(id)).filter(([type]) => type === "correction"),
    ).toEqual([]);
    await setBillingSwitch(t.fixture.db, true);
    expect(
      await correctLateMinutes(t.fixture.db, t.fixture.workspaceId, "no-such-job", t.fixture.clock.now),
    ).toBe("not_billed");
  });
});
