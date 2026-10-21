// SPDX-License-Identifier: Apache-2.0

// The measure of the infrastructure of a job (#493): the VM the Dispatcher reported, the end the App learned (or the
// bounded backstop), the VM of the final claim that counts, and the wall clock of a job without a VM. On SQLite and,
// when TEST_DATABASE_URL is set, on Postgres.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { STOP_RETRY_WINDOW_SECONDS } from "../../billing/minutes.ts";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../../test-support/postgres-test-database.ts";
import type { Database } from "../schema.ts";
import { createJobVmRunsRepository } from "./job-vm-runs-repository.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const VM_TIMEOUT = 1800 + 300;

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

describe.each(databases)("the VM runs of a job on %s", (name, open) => {
  const run = name === "Postgres" && open === undefined ? it.skip : it;

  async function start() {
    const database = await open?.();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      limits: { maxAttempts: 3 },
    });
    const runs = createJobVmRunsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
    /** Claims the next job as a runner and reports one VM for the claim, `afterMs` after the claim. */
    async function claimWithVm(
      vmName: string,
      options: { afterMs?: number; jobId?: string } = {},
    ) {
      const claimed = await fixture.queue.claimNext("pool-a");
      if (claimed === null || claimed.job.claimedAt === null)
        throw new Error("Expected a claim.");
      fixture.clock.advance(options.afterMs ?? 5 * SECOND);
      const startedAt = fixture.clock.now();
      const result = await runs.recordStart({
        jobId: claimed.job.id,
        vmName,
        claimedAt: claimed.job.claimedAt,
        attempt: claimed.job.attempts + 1,
        startedAt,
        vmTimeoutSeconds: VM_TIMEOUT,
      });
      return { claimed, startedAt, result };
    }
    // Not a spread: the fixture's `databasePath` throws on Postgres.
    return {
      db: fixture.db,
      workspaceId: fixture.workspaceId,
      queue: fixture.queue,
      clock: fixture.clock,
      enqueueNew: fixture.enqueueNew,
      tokenOf: fixture.tokenOf,
      runs,
      claimWithVm,
    };
  }

  // #493-T02
  run(
    "records the start of a VM, and a second report of it changes nothing",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const first = await t.claimWithVm("cr-diff-1");
      expect(first.result).toBe("recorded");
      const stored = await t.runs.list(job.id);
      expect(stored).toStrictEqual([
        expect.objectContaining({
          jobId: job.id,
          vmName: "cr-diff-1",
          workspaceId: t.workspaceId,
          attempt: 1,
          startedAt: first.startedAt.toISOString(),
          reportedAt: first.startedAt.toISOString(),
          vmTimeoutSeconds: VM_TIMEOUT,
          endedAt: null,
          endSource: null,
          billable: true,
          billableMinutes: null,
        }),
      ]);

      t.clock.advance(MINUTE);
      const again = await t.runs.recordStart({
        jobId: job.id,
        vmName: "cr-diff-1",
        claimedAt: first.claimed.job.claimedAt as string,
        attempt: 1,
        startedAt: t.clock.now(),
        vmTimeoutSeconds: 99,
      });
      expect(again).toBe("replayed");
      expect(await t.runs.list(job.id)).toStrictEqual(stored);
    },
  );

  // #493-T02
  run(
    "keeps the start between the claim and the report, whatever the Dispatcher's clock says",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const claimed = await t.queue.claimNext("pool-a");
      const claimedAt = claimed?.job.claimedAt as string;
      t.clock.advance(10 * SECOND);
      await t.runs.recordStart({
        jobId: job.id,
        vmName: "early",
        claimedAt,
        attempt: 1,
        startedAt: new Date(Date.parse(claimedAt) - 3600 * SECOND),
        vmTimeoutSeconds: VM_TIMEOUT,
      });
      await t.runs.recordStart({
        jobId: job.id,
        vmName: "late",
        claimedAt,
        attempt: 1,
        startedAt: new Date(t.clock.now().getTime() + 3600 * SECOND),
        vmTimeoutSeconds: VM_TIMEOUT,
      });
      const byName = Object.fromEntries(
        (await t.runs.list(job.id)).map((row) => [row.vmName, row.startedAt]),
      );
      expect(byName).toStrictEqual({
        early: claimedAt,
        late: t.clock.now().toISOString(),
      });
    },
  );

  // #493-T04
  run(
    "refuses the start of a VM for a job that is not running that claim",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const claimed = await t.queue.claimNext("pool-a");
      const claimedAt = claimed?.job.claimedAt as string;
      await t.queue.complete(job.id, claimed?.leaseToken as string, {
        ok: true,
        result: {},
      });
      const input = {
        jobId: job.id,
        vmName: "late",
        claimedAt,
        attempt: 1,
        startedAt: t.clock.now(),
        vmTimeoutSeconds: VM_TIMEOUT,
      };

      expect(await t.runs.recordStart(input)).toBe("refused");
      expect(await t.runs.recordStart({ ...input, jobId: "no-such-job" })).toBe(
        "refused",
      );
      expect(await t.runs.list(job.id)).toStrictEqual([]);
    },
  );

  // #493-T06
  run(
    "ends a VM at the App's clock when the stop answer names it, and the minutes are the started ones",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      await t.claimWithVm("cr-diff-1");
      t.clock.advance(61 * SECOND);
      const stoppedAt = t.clock.now();
      await t.queue.complete(job.id, await t.tokenOf(job.id), {
        ok: true,
        result: {},
      });

      expect(
        await t.runs.confirmStopped(job.id, ["cr-diff-1"], stoppedAt),
      ).toBe(1);

      const [row] = await t.runs.list(job.id);
      expect(row).toMatchObject({
        endedAt: stoppedAt.toISOString(),
        endSource: "app_stop_confirmed",
        billableMinutes: 2,
      });
      expect(await t.runs.measure(job.id)).toMatchObject({
        state: "measured",
        minutes: 2,
        run: { vmName: "cr-diff-1", endSource: "app_stop_confirmed" },
      });
      // A name that is not the job's VM, or another confirmation, changes nothing.
      expect(await t.runs.confirmStopped(job.id, ["other"], stoppedAt)).toBe(0);
      expect(
        await t.runs.confirmStopped(
          job.id,
          ["cr-diff-1"],
          new Date(stoppedAt.getTime() + MINUTE),
        ),
      ).toBe(0);
    },
  );

  // #493-T06
  run("does not measure a job that has not ended", async () => {
    const t = await start();
    const job = await t.enqueueNew();
    await t.claimWithVm("cr-diff-1");

    expect(await t.runs.measure(job.id)).toStrictEqual({ state: "not_ended" });
    expect(await t.runs.measure("no-such-job")).toStrictEqual({
      state: "not_ended",
    });
  });

  // #493-T07
  run(
    "falls back to the backstop when no teardown is confirmed, and a later confirmation replaces it",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const { startedAt } = await t.claimWithVm("cr-diff-1");
      t.clock.advance(10 * MINUTE);
      const endedAt = t.clock.now();
      await t.queue.complete(job.id, await t.tokenOf(job.id), {
        ok: true,
        result: {},
      });
      t.clock.advance(30 * MINUTE);

      const measured = await t.runs.measure(job.id);

      const backstop = new Date(
        endedAt.getTime() + STOP_RETRY_WINDOW_SECONDS * SECOND,
      );
      expect(measured).toMatchObject({
        state: "measured",
        minutes: 11,
        run: {
          endedAt: backstop.toISOString(),
          endSource: "timeout_backstop",
          startedAt: startedAt.toISOString(),
        },
      });

      // The Dispatcher's answer arrives late (a retried stop): a confirmation is better evidence than the guess.
      const confirmed = new Date(endedAt.getTime() + 20 * SECOND);
      expect(
        await t.runs.confirmStopped(job.id, ["cr-diff-1"], confirmed),
      ).toBe(1);
      expect(await t.runs.measure(job.id)).toMatchObject({
        minutes: 11,
        run: {
          endedAt: confirmed.toISOString(),
          endSource: "app_stop_confirmed",
        },
      });
    },
  );

  // #493-T07
  run("never bills past the VM's own timeout", async () => {
    const t = await start();
    const job = await t.enqueueNew();
    const { startedAt } = await t.claimWithVm("cr-diff-1");
    // The job runs past the VM's timeout (a lease the App never ended): the platform ended the VM at its timeout.
    t.clock.advance((VM_TIMEOUT + 600) * SECOND);
    await t.queue.complete(job.id, await t.tokenOf(job.id), {
      ok: true,
      result: {},
    });

    const measured = await t.runs.measure(job.id);

    expect(measured).toMatchObject({
      state: "measured",
      minutes: Math.ceil(VM_TIMEOUT / 60),
      run: {
        endedAt: new Date(
          startedAt.getTime() + VM_TIMEOUT * SECOND,
        ).toISOString(),
        endSource: "timeout_backstop",
      },
    });
  });

  // #493-T08
  run(
    "stores every VM of a job with two attempts and counts only the final claim's",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const first = await t.claimWithVm("cr-diff-first");
      // The first launch failed after the VM was created: the Dispatcher gave the job back.
      await t.queue.release(job.id, first.claimed.leaseToken, "launch_failed", {
        retryAt: t.clock.now(),
      });
      t.clock.advance(SECOND);
      const second = await t.claimWithVm("cr-diff-second");
      expect(second.result).toBe("recorded");
      // Three minutes and a second after the second VM started: four started minutes.
      t.clock.advance(3 * MINUTE + SECOND);
      const endedAt = t.clock.now();
      await t.queue.complete(job.id, second.claimed.leaseToken, {
        ok: true,
        result: {},
      });
      await t.runs.confirmStopped(job.id, ["cr-diff-second"], endedAt);

      const rows = await t.runs.list(job.id);
      expect(
        rows.map((row) => [row.vmName, row.attempt, row.billable]),
      ).toStrictEqual([
        ["cr-diff-first", 1, false],
        ["cr-diff-second", 2, true],
      ]);
      const measured = await t.runs.measure(job.id);
      expect(measured).toMatchObject({
        state: "measured",
        minutes: 4,
        run: { vmName: "cr-diff-second" },
      });
    },
  );

  // #493-T08
  run(
    "bills nothing for the VM of a lost attempt when the final attempt never created a VM",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const first = await t.claimWithVm("cr-diff-first");
      await t.queue.release(job.id, first.claimed.leaseToken, "launch_failed", {
        retryAt: t.clock.now(),
      });
      t.clock.advance(SECOND);
      const second = await t.queue.claimNext("pool-a");
      // The second launch failed before a VM existed: nothing was reported for this claim.
      await t.queue.release(
        job.id,
        second?.leaseToken as string,
        "launch_failed",
        {
          retryAt: t.clock.now(),
        },
      );
      t.clock.advance(SECOND);
      const third = await t.queue.claimNext("pool-a");
      const final = await t.queue.release(
        job.id,
        third?.leaseToken as string,
        "launch_failed",
      );
      expect(final.status).toBe("failed");

      expect(await t.runs.measure(job.id)).toStrictEqual({
        state: "measured",
        minutes: 0,
        run: null,
      });
      expect(
        (await t.runs.list(job.id)).map((row) => row.billable),
      ).toStrictEqual([false]);
    },
  );

  // #493-T08
  run("does not count a second VM reported for the same claim", async () => {
    const t = await start();
    const job = await t.enqueueNew();
    const { claimed } = await t.claimWithVm("cr-diff-a");
    await t.runs.recordStart({
      jobId: job.id,
      vmName: "cr-diff-b",
      claimedAt: claimed.job.claimedAt as string,
      attempt: 1,
      startedAt: t.clock.now(),
      vmTimeoutSeconds: VM_TIMEOUT,
    });

    expect(
      (await t.runs.list(job.id)).map((row) => [row.vmName, row.billable]),
    ).toStrictEqual([
      ["cr-diff-a", true],
      ["cr-diff-b", false],
    ]);
  });

  // #493-T09
  run(
    "measures the wall clock of a job that has no VM, from its claim to its end",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const claimed = await t.queue.claimNext("self-hosted");
      t.clock.advance(125 * SECOND);
      await t.queue.complete(job.id, claimed?.leaseToken as string, {
        ok: true,
        result: {},
      });

      expect(await t.runs.recordWallClock(job.id)).toBe("recorded");
      expect(await t.runs.recordWallClock(job.id)).toBe("replayed");

      expect(await t.runs.list(job.id)).toStrictEqual([
        expect.objectContaining({
          vmName: "job_wall_clock",
          startedAt: claimed?.job.claimedAt,
          endedAt: t.clock.now().toISOString(),
          endSource: "job_wall_clock",
          vmTimeoutSeconds: null,
          billable: true,
          billableMinutes: 3,
        }),
      ]);
      expect(await t.runs.measure(job.id)).toMatchObject({
        minutes: 3,
        run: { endSource: "job_wall_clock" },
      });
    },
  );

  // #493-T09
  run(
    "does not measure the wall clock of a job that is still running or never ran",
    async () => {
      const t = await start();
      const running = await t.enqueueNew();
      await t.queue.claimNext("self-hosted");
      const queued = await t.enqueueNew({ prNumber: 8 });

      expect(await t.runs.recordWallClock(running.id)).toBe("not_measurable");
      expect(await t.runs.recordWallClock(queued.id)).toBe("not_measurable");
      expect(await t.runs.list(running.id)).toStrictEqual([]);
    },
  );

  // #493-T10
  run(
    "has no row and no minutes for a job that failed before any VM was created",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const claimed = await t.queue.claimNext("pool-a");
      await t.queue.cancelClaimed(
        job.id,
        claimed?.leaseToken as string,
        "project_deactivated",
      );

      expect(await t.runs.list(job.id)).toStrictEqual([]);
      expect(await t.runs.measure(job.id)).toStrictEqual({
        state: "measured",
        minutes: 0,
        run: null,
      });
    },
  );

  // #498-B1 (the review of #524): the stop answer proves a VM that nobody reported.
  run(
    "creates the row of a VM the stop answer names when its report never arrived, from the claim to the stop",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const claimed = await t.queue.claimNext("pool-a");
      const claimedAt = new Date(claimed?.job.claimedAt as string);
      t.clock.advance(2 * MINUTE + 10 * SECOND);
      await t.queue.complete(job.id, claimed?.leaseToken as string, {
        ok: true,
        result: {},
      });
      const vm = `cr-diff-${job.id}-ab12cd34`;

      const changed = await t.runs.confirmStopped(job.id, [vm], t.clock.now());

      expect(changed).toBe(1);
      expect(await t.runs.list(job.id)).toStrictEqual([
        expect.objectContaining({
          vmName: vm,
          startedAt: claimedAt.toISOString(),
          endedAt: t.clock.now().toISOString(),
          endSource: "app_stop_unreported",
          billable: true,
          billableMinutes: 3,
        }),
      ]);
      expect(await t.runs.measure(job.id)).toMatchObject({
        state: "measured",
        minutes: 3,
        run: { vmName: vm },
      });
    },
  );

  // #498-B1
  run(
    "makes no row for a name that is not a VM of the job, and none for the VM of a claim that was given back",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const claimed = await t.queue.claimNext("pool-a");

      expect(
        await t.runs.confirmStopped(
          job.id,
          ["cr-diff-someone-else-ab12", `cr-diff-${job.id}`, `x-${job.id}-ab`],
          t.clock.now(),
        ),
      ).toBe(0);
      await t.queue.release(job.id, claimed?.leaseToken as string, "worker_exited", {
        retryAt: t.clock.now(),
      });
      expect(
        await t.runs.confirmStopped(
          job.id,
          [`cr-diff-${job.id}-ab12cd34`],
          t.clock.now(),
        ),
      ).toBe(0);
      expect(await t.runs.list(job.id)).toStrictEqual([]);
    },
  );

  // #498-B1 / N-1
  run("keeps at most four VMs for one claim", async () => {
    const t = await start();
    const job = await t.enqueueNew();
    const claimed = await t.queue.claimNext("pool-a");

    const answers: string[] = [];
    for (let index = 0; index < 6; index += 1)
      answers.push(
        await t.runs.recordStart({
          jobId: job.id,
          vmName: `cr-diff-${job.id}-vm${String(index)}`,
          claimedAt: claimed?.job.claimedAt as string,
          attempt: 1,
          startedAt: t.clock.now(),
          vmTimeoutSeconds: VM_TIMEOUT,
        }),
      );

    expect((await t.runs.list(job.id)).length).toBe(4);
    expect(answers.slice(0, 4)).toStrictEqual(Array(4).fill("recorded"));
    // The rest are answered like a repeat: nothing is stored and the Dispatcher's launch goes on.
    expect(answers.slice(4)).toStrictEqual(["replayed", "replayed"]);
  });

  // #498-B1
  run(
    "falls back to the claim wall clock for a hosted job that ran with no VM row, flagged by its source",
    async () => {
      const t = await start();
      const job = await t.enqueueNew();
      const claimed = await t.queue.claimNext("pool-a");
      t.clock.advance(3 * MINUTE + SECOND);
      await t.queue.complete(job.id, claimed?.leaseToken as string, {
        ok: true,
        result: {},
      });

      expect(await t.runs.recordWallClock(job.id, "claim_wall_clock")).toBe(
        "recorded",
      );
      expect(await t.runs.recordWallClock(job.id, "claim_wall_clock")).toBe(
        "replayed",
      );

      expect(await t.runs.measure(job.id)).toMatchObject({
        state: "measured",
        minutes: 4,
        run: { endSource: "claim_wall_clock", billable: true },
      });
    },
  );
});
