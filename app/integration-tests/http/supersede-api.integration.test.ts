// SPDX-License-Identifier: Apache-2.0

// What the runner API and the Worker API do for a run that a newer push replaced (#397), through the real handlers
// and a real SQLite file: the feature `supersede` is noted from the claim (a runner) or the job details request (a
// Worker), the heartbeat of the superseded claim says so, its report is stored once and the job stays superseded,
// and the job state call says that it drains.
import { describe, expect, it } from "vitest";
import {
  goodResult,
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const SHA_B = "b".repeat(40);

/** A Worker that named `supersede` in its details request, and the newer push that replaced its run. */
async function supersededWorker(h: RunnerApiHarness) {
  const old = await h.enqueueNew({ prNumber: 7 });
  const worker = await h.startedWorker("dynamic_capabilities,supersede");
  const pushed = await h.enqueue({ prNumber: 7, headSha: SHA_B });
  return { old, worker, pushed };
}

const SUPERSEDED = goodResult({
  ok: false,
  errorCode: "superseded",
  commentUrl: null,
  logTail: "superseded: a newer push replaced this run",
});

describe("noting that the holder understands the supersede", () => {
  // #397-T15
  it("sets the flag from the features of a runner's claim", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();

    await h.claim({ engines: ["pr-agent"], features: ["supersede"] });

    expect(await flagOf(h, job.id)).toBe(1);
  });

  // #397-T15
  it("does not set it for a claim that names no such feature, or for a Dispatcher's split claim", async () => {
    const h = await startRunnerApiHarness();
    const first = await h.enqueueNew({ prNumber: 7 });
    await h.claim();
    expect(await flagOf(h, first.id)).toBe(0);

    const second = await h.enqueueNew({ prNumber: 8, headSha: SHA_B });
    await h.claimSplit({ features: ["supersede"] });
    expect(await flagOf(h, second.id)).toBe(0);
  });

  // #397-T15
  it("sets it when the Worker's job details request names the feature, and not otherwise", async () => {
    const h = await startRunnerApiHarness();
    const plain = await h.enqueueNew({ prNumber: 7 });
    await h.startedWorker();
    expect(await flagOf(h, plain.id)).toBe(0);

    const named = await h.enqueueNew({ prNumber: 8, headSha: SHA_B });
    await h.startedWorker("supersede");
    expect(await flagOf(h, named.id)).toBe(1);
  });
});

async function flagOf(h: RunnerApiHarness, jobId: string): Promise<number> {
  const row = await h.db
    .selectFrom("jobs")
    .select("accepts_supersede")
    .where("id", "=", jobId)
    .executeTakeFirstOrThrow();
  return row.accepts_supersede;
}

describe("the heartbeat of a superseded claim", () => {
  // #397-T05
  it("tells a Worker so, without extending the lease, and a running claim's answer has no such field", async () => {
    const h = await startRunnerApiHarness();
    const running = await h.enqueueNew({ prNumber: 8, headSha: SHA_B });
    const other = await h.startedWorker();
    const plain = await (
      await h.worker.heartbeat(running.id, other.credential)
    ).json();
    expect(plain.job).not.toHaveProperty("superseded");

    const { old, worker } = await supersededWorker(h);
    const lease = (await h.queue.get(old.id))?.leaseExpiresAt;
    h.clock.advance(30_000);
    const response = await h.worker.heartbeat(old.id, worker.credential);

    expect(response.status).toBe(200);
    expect((await response.json()).job).toMatchObject({
      id: old.id,
      superseded: true,
    });
    expect((await h.queue.get(old.id))?.leaseExpiresAt).toBe(lease);
  });

  // #397-T05
  it("tells a runner of the legacy API so", async () => {
    const h = await startRunnerApiHarness();
    const old = await h.enqueueNew({ prNumber: 7 });
    const claimed = await h.claimed({
      engines: ["pr-agent"],
      features: ["supersede"],
    });
    await h.enqueue({ prNumber: 7, headSha: SHA_B });

    const response = await h.heartbeat(old.id, claimed.job.leaseToken);

    expect(response.status).toBe(200);
    expect((await response.json()).job.superseded).toBe(true);
  });

  // #397-T05
  it("is refused with the usual codes once the drain is over", async () => {
    const h = await startRunnerApiHarness();
    const { old, worker } = await supersededWorker(h);

    h.clock.advance(151_000);
    const response = await h.worker.heartbeat(old.id, worker.credential);

    expect(response.status).toBe(409);
  });
});

describe("the report of a superseded claim", () => {
  // #397-T06
  it("is stored once through the Worker API: 200, the job stays superseded, the cost is usage; the same again is 200, another is 409", async () => {
    const h = await startRunnerApiHarness();
    const { old, worker } = await supersededWorker(h);

    const first = await h.worker.result(old.id, worker.credential, SUPERSEDED);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      job: { id: old.id, status: "superseded" },
      alreadyCompleted: false,
    });
    const job = await h.queue.get(old.id);
    expect(job?.status).toBe("superseded");
    expect(job?.result).toMatchObject({ errorCode: "superseded" });

    const again = await h.worker.result(old.id, worker.credential, SUPERSEDED);
    expect(again.status).toBe(200);
    expect((await again.json()).alreadyCompleted).toBe(true);
    const other = await h.worker.result(old.id, worker.credential, {
      ...SUPERSEDED,
      logTail: "something else",
    });
    expect(other.status).toBe(409);
  });

  // #397-T06
  it("is stored once through the runner API too", async () => {
    const h = await startRunnerApiHarness();
    const old = await h.enqueueNew({ prNumber: 7 });
    const claimed = await h.claimed({
      engines: ["pr-agent"],
      features: ["supersede"],
    });
    await h.enqueue({ prNumber: 7, headSha: SHA_B });

    const response = await h.complete(
      old.id,
      claimed.job.leaseToken,
      SUPERSEDED,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).job.status).toBe("superseded");
  });

  // #397-T06
  it("is refused for a Worker whose details were never fetched under another credential", async () => {
    const h = await startRunnerApiHarness();
    const { old } = await supersededWorker(h);

    const response = await h.worker.result(
      old.id,
      `crj_${"x".repeat(43)}`,
      SUPERSEDED,
    );

    expect(response.status).toBe(401);
  });
});

describe("the job state call", () => {
  // #397-T12
  it("says that a superseded job whose claim is valid is draining, and that it is not once it reported or ran out", async () => {
    const h = await startRunnerApiHarness();
    const { old, worker } = await supersededWorker(h);
    const state = async () => (await (await h.jobState(old.id)).json()).job;

    expect(await state()).toEqual({
      id: old.id,
      status: "superseded",
      draining: true,
    });

    await h.worker.result(old.id, worker.credential, SUPERSEDED);
    expect(await state()).toEqual({ id: old.id, status: "superseded" });
  });

  // #397-T12
  it("says it is not draining after the drain ran out, and never for another status", async () => {
    const h = await startRunnerApiHarness();
    const { old, pushed } = await supersededWorker(h);

    h.clock.advance(151_000);
    expect(await (await h.jobState(old.id)).json()).toMatchObject({
      job: { status: "superseded" },
    });
    expect((await (await h.jobState(old.id)).json()).job).not.toHaveProperty(
      "draining",
    );
    const queued = await (
      await h.jobState(pushed.status === "created" ? pushed.job.id : "")
    ).json();
    expect(queued.job).toEqual({
      id: pushed.status === "created" ? pushed.job.id : "",
      status: "queued",
    });
  });
});
