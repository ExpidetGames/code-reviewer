// SPDX-License-Identifier: LicenseRef-Proprietary

// What the runner API and the Worker API tell the server when a job ends or a call touches the database (#395),
// through the real handlers and a real SQLite file: the end of a job (a result, a job given back by a Worker or
// by a Dispatcher) is reported once, with the pull request, so the jobs that waited for the slot can be sent
// without the sweep; a heartbeat and a result are the moments at which repair work may run.
import { describe, expect, it, vi } from "vitest";
import type { JobEndedEvent } from "../../src/dispatch/job-ended.ts";
import { startRunnerApiHarness } from "../../src/test-support/runner-api-harness.ts";

function start() {
  const ended: JobEndedEvent[] = [];
  const activity = vi.fn();
  return {
    ended,
    activity,
    harness: startRunnerApiHarness({
      hooks: { jobEnded: (event) => ended.push(event), activity },
    }),
  };
}

describe("the end of a job", () => {
  // #395-T09
  it("is reported when a Worker delivers its result, once, with its pull request", async () => {
    const t = start();
    const h = await t.harness;
    const job = await h.enqueueNew({ prNumber: 7 });
    const { credential } = await h.startedWorker();

    expect((await h.worker.result(job.id, credential)).status).toBe(200);
    // The same result again changes nothing and ends nothing.
    expect((await h.worker.result(job.id, credential)).status).toBe(200);

    expect(t.ended).toEqual([
      {
        jobId: job.id,
        repositoryId: job.repositoryId,
        prNumber: 7,
        requeued: false,
      },
    ]);
  });

  // #395-T09
  it("is reported when a runner completes its job through the runner API", async () => {
    const t = start();
    const h = await t.harness;
    const job = await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
    const claimed = await h.claimed();

    await h.complete(job.id, claimed.job.leaseToken);

    expect(t.ended).toMatchObject([
      { jobId: job.id, prNumber: 8, requeued: false },
    ]);
  });

  // #395-T09
  it("is reported as given back when a Dispatcher releases a job after a failed launch", async () => {
    const t = start();
    const h = await t.harness;
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();

    const response = await h.release(job.id, {
      credential: claim.job.credential,
      reason: "launch_failed",
    });

    expect(response.status).toBe(200);
    expect(t.ended).toMatchObject([{ jobId: job.id, requeued: true }]);
  });

  // #395-T09
  it("is reported as over when the last allowed attempt is released", async () => {
    const t = start();
    const h = await t.harness;
    const job = await h.enqueueNew();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claim = await h.claimedSplit();
      await h.release(job.id, {
        credential: claim.job.credential,
        reason: "launch_failed",
      });
    }

    expect(t.ended.map((event) => event.requeued)).toEqual([true, true, false]);
  });

  // #395-T09
  it("is not reported for a call that was refused", async () => {
    const t = start();
    const h = await t.harness;
    const job = await h.enqueueNew();
    await h.claimedSplit();

    expect(
      (
        await h.release(job.id, {
          credential: `crj_${"x".repeat(43)}`,
          reason: "launch_failed",
        })
      ).status,
    ).toBe(401);
    expect(
      (await h.worker.result(job.id, `crj_${"y".repeat(43)}`)).status,
    ).toBe(401);

    expect(t.ended).toEqual([]);
    expect(t.activity).not.toHaveBeenCalled();
  });
});

describe("a call that touches the database", () => {
  // #395-T11
  it("tells the server after a heartbeat and after a result, and not after a refusal", async () => {
    const t = start();
    const h = await t.harness;
    const job = await h.enqueueNew();
    const { credential } = await h.startedWorker();

    await h.worker.heartbeat(job.id, credential);
    expect(t.activity).toHaveBeenCalledTimes(1);
    await h.worker.heartbeat(job.id, `crj_${"z".repeat(43)}`);
    expect(t.activity).toHaveBeenCalledTimes(1);
    await h.worker.result(job.id, credential);
    expect(t.activity).toHaveBeenCalledTimes(2);
  });

  // #395-T11
  it("tells the server after a heartbeat of the runner API", async () => {
    const t = start();
    const h = await t.harness;
    const job = await h.enqueueNew();
    const claimed = await h.claimed();

    const response = await h.heartbeat(job.id, claimed.job.leaseToken);

    expect(response.status).toBe(200);
    expect(t.activity).toHaveBeenCalledTimes(1);
  });
});
