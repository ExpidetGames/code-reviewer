// SPDX-License-Identifier: Apache-2.0

// The measure of a job without a VM (#493): where billing is on, the wall clock of a job on a runner (a self-hosted
// runner, Compose) is recorded when its claim ends. Billing off: nothing is read and nothing is written. A job that a
// Dispatcher started has a VM and is measured by the VM. On SQLite and, when TEST_DATABASE_URL is set, on Postgres.
import type { Kysely } from "kysely";
import { describe, expect, it as vitestIt } from "vitest";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import type { Database } from "../db/schema.ts";
import { decideOutcome } from "../dispatch/outcome.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createWallClockRecorder } from "./wall-clock.ts";

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

describe.each(databases)("the wall clock of a job on %s", (name, open) => {
  const it =
    name === "Postgres" && open === undefined ? vitestIt.skip : vitestIt;

  async function setup(options: { billing: boolean }) {
    const database = await open?.();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
    });
    await setBillingSwitch(fixture.db, options.billing);
    const recorder = createWallClockRecorder({
      db: fixture.db,
      now: fixture.clock.now,
    });
    const runs = createJobVmRunsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    let pr = 6;
    /** A job a runner claimed and finished after `seconds`. */
    async function finishedJob(seconds: number, finish = true) {
      pr += 1;
      const job = await fixture.enqueueNew({
        prNumber: pr,
        prUrl: `https://github.test/acme/widgets/pull/${String(pr)}`,
      });
      const claimed = await fixture.queue.claimNext("self-hosted");
      fixture.clock.advance(seconds * SECOND);
      if (finish)
        await fixture.queue.complete(job.id, claimed?.leaseToken as string, {
          ok: true,
          result: {},
        });
      return job.id;
    }
    return { fixture, recorder, runs, finishedJob };
  }

  // #493-T09
  it("records one wall clock row for a job on a runner while billing is on", async () => {
    const t = await setup({ billing: true });
    const id = await t.finishedJob(90);

    await t.recorder.recordFor([id]);
    await t.recorder.recordFor([id]);

    expect(await t.runs.list(id)).toStrictEqual([
      expect.objectContaining({
        vmName: "job_wall_clock",
        endSource: "job_wall_clock",
        billable: true,
        billableMinutes: 2,
      }),
    ]);
  });

  // #493-T09
  it("records nothing while billing is off", async () => {
    const t = await setup({ billing: false });
    const id = await t.finishedJob(90);

    await t.recorder.recordFor([id]);

    expect(await t.runs.list(id)).toStrictEqual([]);
  });

  // #493-T09
  it("leaves a job that a Dispatcher started to its VM", async () => {
    const t = await setup({ billing: true });
    const id = await t.finishedJob(90);
    const dispatches = createJobDispatchesRepository(
      t.fixture.db,
      t.fixture.clock.now,
    );
    const at = t.fixture.clock.now();
    await dispatches.create(id, at);
    const row = await dispatches.get(id);
    await dispatches.claimSend(id, row?.nextDispatchAt ?? "", at);
    await dispatches.record(id, decideOutcome({ kind: "accepted" }, 0, at), at);

    await t.recorder.recordFor([id]);

    expect(await t.runs.list(id)).toStrictEqual([]);
  });

  // #493-T10
  it("records nothing for a job that has not ended, never ran or is unknown", async () => {
    const t = await setup({ billing: true });
    const running = await t.finishedJob(30, false);
    const never = await t.fixture.enqueueNew({
      prNumber: 40,
      prUrl: "https://github.test/acme/widgets/pull/40",
    });

    await t.recorder.recordFor([running, never.id, "no-such-job"]);

    expect(await t.runs.list(running)).toStrictEqual([]);
    expect(await t.runs.list(never.id)).toStrictEqual([]);
  });

  // #493-T09
  it("never throws when the database cannot be read", async () => {
    const t = await setup({ billing: true });
    const id = await t.finishedJob(30);
    await t.fixture.db.destroy();

    await expect(t.recorder.recordFor([id])).resolves.toBeUndefined();
  });
});
