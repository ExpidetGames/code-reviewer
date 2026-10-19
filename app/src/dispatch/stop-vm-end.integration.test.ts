// SPDX-License-Identifier: Apache-2.0

// The end of a VM's billable minutes (#493): when the Dispatcher's answer to the App's stop call names the VMs it is
// stopping, the App's clock at that moment is their end (`app_stop_confirmed`). Any other answer, or none, leaves the end
// to the bounded backstop that `measure` applies (`timeout_backstop`); the stop never fails or delays anything. On SQLite
// and, when TEST_DATABASE_URL is set, on Postgres.
import type { Kysely } from "kysely";
import { describe, expect, it as vitestIt } from "vitest";
import { STOP_RETRY_WINDOW_SECONDS } from "../billing/minutes.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import type { Database } from "../db/schema.ts";
import { createFakeDispatchReceiver } from "../test-support/fake-dispatch-receiver.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import type { WebhookDispatchConfig } from "./config.ts";
import { decideOutcome } from "./outcome.ts";
import { createStopService } from "./stop.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const CURRENT = {
  kid: "k2",
  secret: "example-dispatch-secret-current-00000000",
};
const webhookConfig: WebhookDispatchConfig = {
  mode: "webhook",
  url: "https://dispatcher.example.test/dispatch",
  currentKey: CURRENT,
  previousKey: null,
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

describe.each(databases)("the end of a VM on %s", (name, open) => {
  const it =
    name === "Postgres" && open === undefined ? vitestIt.skip : vitestIt;

  async function setup() {
    const database = await open?.();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
    });
    const receiver = createFakeDispatchReceiver({
      keys: [CURRENT],
      now: fixture.clock.now,
    });
    const warnings: string[] = [];
    const service = createStopService({
      db: fixture.db,
      config: webhookConfig,
      fetch: receiver.fetch,
      now: fixture.clock.now,
      timeoutMs: 40,
      sleep: () => Promise.resolve(),
      log: { warn: (line) => warnings.push(line) },
    });
    const runs = createJobVmRunsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    /**
     * A job a Dispatcher acknowledged, claimed, with a VM reported for the claim and then completed one minute and a bit
     * later: the state in which the App sends its stop.
     */
    let pr = 6;
    async function endedJobWithVm() {
      pr += 1;
      const job = await fixture.enqueueNew({
        prNumber: pr,
        prUrl: `https://github.test/acme/widgets/pull/${String(pr)}`,
      });
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
    return { fixture, receiver, warnings, service, runs, endedJobWithVm };
  }

  // #493-T06
  it("ends a VM at the App's clock when the answer to the stop names it", async () => {
    const t = await setup();
    const id = await t.endedJobWithVm();
    t.fixture.clock.advance(3 * SECOND);
    t.receiver.reply(stoppingVms(VM));

    await t.service.stopJobs([id]);

    const [row] = await t.runs.list(id);
    expect(row).toMatchObject({
      endedAt: t.fixture.clock.now().toISOString(),
      endSource: "app_stop_confirmed",
      billableMinutes: 2,
    });
    expect(await t.runs.measure(id)).toMatchObject({ minutes: 2 });
    expect(t.warnings).toEqual([]);
  });

  // #493-T06
  it("ignores names that are not VMs of the job, and an answer that is not the shape of the contract", async () => {
    const t = await setup();
    const id = await t.endedJobWithVm();
    t.receiver.reply(
      stoppingVms("cr-diff-someone-else"),
      stoppingVms(VM, 42),
      stoppingVms(...Array.from({ length: 17 }, (_, index) => `vm-${index}`)),
      { status: 202, body: "not json" },
      { status: 202, body: JSON.stringify({ vms: VM }) },
    );

    for (let call = 0; call < 5; call += 1) await t.service.stopJobs([id]);

    expect((await t.runs.list(id))[0]).toMatchObject({
      endedAt: null,
      endSource: null,
    });
    expect(t.warnings).toEqual([]);
  });

  // #493-T07
  it("leaves the end to the backstop when the stop call fails, and the job stays as it ended", async () => {
    const t = await setup();
    const id = await t.endedJobWithVm();
    const jobEndedAt = t.fixture.clock.now();
    t.receiver.reply({ status: 503 }, { status: 500 }, { fails: "down" });
    t.fixture.clock.advance(10 * MINUTE);

    await t.service.stopJobs([id]);

    expect(t.warnings).toEqual([`[dispatch] DISPATCH_STOP_FAILED job=${id}`]);
    expect((await t.runs.list(id))[0]).toMatchObject({ endedAt: null });
    expect(await t.fixture.queue.get(id)).toMatchObject({
      status: "succeeded",
    });
    expect(await t.runs.measure(id)).toMatchObject({
      state: "measured",
      minutes: 2,
      run: {
        endedAt: new Date(
          jobEndedAt.getTime() + STOP_RETRY_WINDOW_SECONDS * SECOND,
        ).toISOString(),
        endSource: "timeout_backstop",
      },
    });
  });

  // #493-T07
  it("leaves the end to the backstop for a Dispatcher of the previous release, which names no VM", async () => {
    const t = await setup();
    const first = await t.endedJobWithVm();
    t.receiver.reply({
      status: 202,
      body: JSON.stringify({ version: 1, status: "stopping" }),
    });
    const second = await t.endedJobWithVm();
    t.receiver.reply({ status: 404 });

    await t.service.stopJobs([first]);
    await t.service.stopJobs([second]);

    for (const id of [first, second])
      expect(await t.runs.measure(id)).toMatchObject({
        run: { endSource: "timeout_backstop" },
      });
  });

  // #493-T07
  it("leaves the end to the backstop when the Dispatcher found no VM, and a later confirmation of the stop still wins", async () => {
    const t = await setup();
    const id = await t.endedJobWithVm();
    t.receiver.reply({
      status: 200,
      body: JSON.stringify({ version: 1, status: "ignored", reason: "no_vm" }),
    });
    await t.service.stopJobs([id]);
    expect(await t.runs.measure(id)).toMatchObject({
      run: { endSource: "timeout_backstop" },
    });

    t.receiver.reply(stoppingVms(VM));
    await t.service.stopJobs([id]);

    expect(await t.runs.measure(id)).toMatchObject({
      run: { endSource: "app_stop_confirmed" },
    });
  });
});
