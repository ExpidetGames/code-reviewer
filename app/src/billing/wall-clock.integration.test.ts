// SPDX-License-Identifier: LicenseRef-Proprietary

// The measure of a job without a VM (#493): where billing is on, the wall clock of a job on a runner (a self-hosted
// runner, Compose) is recorded when its claim ends. Billing off: nothing is read and nothing is written. A job that a
// Dispatcher started has a VM and is measured by the VM.
import { describe, expect, it } from "vitest";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import { decideOutcome } from "../dispatch/outcome.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
import { createWallClockRecorder } from "./wall-clock.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const SECOND = 1000;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

describe("the wall clock of a job", () => {
  async function setup(options: { billing: boolean }) {
    const database = await open();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
    });
    await setBillingSwitch(fixture.db, options.billing);
    // While billing is on the claim holds money (#498): the workspace has some.
    if (options.billing)
      await fundWorkspace(fixture.db, fixture.workspaceId, 100_000_000);
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
    async function finishedJob(
      seconds: number,
      finish = true,
      /** Runs while the job runs: a Dispatcher acknowledging it (#498 measures a job when it ends, so it is hosted by then). */
      whileRunning?: (jobId: string) => Promise<void>,
      /** How the claim ends; the default is a delivered result. */
      outcome: Parameters<typeof fixture.queue.complete>[2] = {
        ok: true,
        result: {},
      },
    ) {
      pr += 1;
      const job = await fixture.enqueueNew({
        prNumber: pr,
        prUrl: `https://github.test/acme/widgets/pull/${String(pr)}`,
      });
      const claimed = await fixture.queue.claimNext("self-hosted");
      await whileRunning?.(job.id);
      fixture.clock.advance(seconds * SECOND);
      if (finish)
        await fixture.queue.complete(
          job.id,
          claimed?.leaseToken as string,
          outcome,
        );
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
    const dispatches = createJobDispatchesRepository(
      t.fixture.db,
      t.fixture.clock.now,
    );
    // The run fails with a code that is clearly ours: settlement prices it free and does not measure it, so any row for the job
    // would be the recorder's.
    const id = await t.finishedJob(
      90,
      true,
      async (jobId) => {
        const at = t.fixture.clock.now();
        await dispatches.create(jobId, at);
        const row = await dispatches.get(jobId);
        await dispatches.claimSend(jobId, row?.nextDispatchAt ?? "", at);
        await dispatches.record(
          jobId,
          decideOutcome({ kind: "accepted" }, 0, at),
          at,
        );
      },
      { ok: false, errorCode: "runner_error", result: null },
    );

    await t.recorder.recordFor([id]);

    // The recorder adds nothing for a job a Dispatcher started: that is the VM's.
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
