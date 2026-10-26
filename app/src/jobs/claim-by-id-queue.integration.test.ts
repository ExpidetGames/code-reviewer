// SPDX-License-Identifier: LicenseRef-Proprietary

// The claim by job id and the pool cap of the queue (#322): `jobId` claims exactly that job (and nothing else), `maxRunning` counts the running
// jobs of the pool (the runner id) inside the claim transaction, and a claim without either behaves as
// before.
import { describe, expect, it } from "vitest";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const MINUTE = 60 * 1000;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

describe("the claim by job id", () => {
  async function start(options: { dynamicReview?: boolean } = {}) {
    const database = await open();
    return createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      ...options,
    });
  }

  // #322-T01
  it("claims exactly the job it names, not the oldest one", async () => {
    const fixture = await start();
    const oldest = await fixture.enqueueNew({ prNumber: 7 });
    fixture.clock.advance(1000);
    const wanted = await fixture.enqueueNew({
      prNumber: 8,
      headSha: sha("b"),
    });
    fixture.clock.advance(1000);
    await fixture.enqueueNew({ prNumber: 9, headSha: sha("c") });

    const claimed = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
      jobId: wanted.id,
    });

    expect(claimed?.job).toMatchObject({
      id: wanted.id,
      status: "running",
      runnerId: "dispatcher-a",
    });
    expect(claimed?.credential).toEqual(expect.any(String));
    expect((await fixture.queue.get(oldest.id))?.status).toBe("queued");
    // The next claim without an id still takes the oldest.
    const next = await fixture.queue.claimNext("dispatcher-a");
    expect(next?.job.id).toBe(oldest.id);
  });

  // #322-T01
  it("claims by id with the legacy lease token too", async () => {
    const fixture = await start();
    await fixture.enqueueNew({ prNumber: 7 });
    const wanted = await fixture.enqueueNew({ prNumber: 8, headSha: sha("b") });

    const claimed = await fixture.queue.claimNext("runner-a", undefined, {
      jobId: wanted.id,
    });

    expect(claimed?.job.id).toBe(wanted.id);
    expect(claimed).not.toHaveProperty("credential");
  });

  // #322-T02
  it("answers nothing for an id that does not exist", async () => {
    const fixture = await start();
    await fixture.enqueueNew();

    expect(
      await fixture.queue.claimNext("dispatcher-a", undefined, {
        jobId: crypto.randomUUID(),
      }),
    ).toBeNull();
    expect((await fixture.queue.list({ status: "queued" })).length).toBe(1);
  });

  // #322-T02
  it("answers nothing for a job that is not due yet, then claims it", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew();
    const first = await fixture.queue.claimNext("dispatcher-a");
    await fixture.queue.release(job.id, first?.leaseToken ?? "", "x", {
      retryAt: new Date(fixture.clock.now().getTime() + 5 * MINUTE),
    });

    expect(
      await fixture.queue.claimNext("dispatcher-a", undefined, {
        jobId: job.id,
      }),
    ).toBeNull();
    fixture.clock.advance(5 * MINUTE);
    const claimed = await fixture.queue.claimNext("dispatcher-a", undefined, {
      jobId: job.id,
    });
    expect(claimed?.job).toMatchObject({ id: job.id, attempts: 1 });
  });

  // #322-T02
  it("answers nothing for a job that is running, and leaves its claim alone", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew();
    const first = await fixture.queue.claimNext("dispatcher-a");

    expect(
      await fixture.queue.claimNext("dispatcher-b", undefined, {
        jobId: job.id,
      }),
    ).toBeNull();
    expect(await fixture.tokenOf(job.id)).toBe(first?.leaseToken);
    expect((await fixture.queue.get(job.id))?.runnerId).toBe("dispatcher-a");
  });

  // #322-T02
  it("answers nothing for a job that finished, failed, was cancelled or superseded", async () => {
    const fixture = await start();
    const finished = await fixture.enqueueNew({ prNumber: 7 });
    const claimed = await fixture.queue.claimNext("dispatcher-a");
    await fixture.queue.complete(finished.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {},
    });
    const failed = await fixture.seedHistoricalJob({
      command: "review",
      status: "failed",
      prNumber: 8,
      errorCode: "command_failed",
    });
    const cancelled = await fixture.seedHistoricalJob({
      command: "review",
      status: "cancelled",
      prNumber: 9,
    });
    const old = await fixture.enqueueNew({ prNumber: 10, headSha: sha("a") });
    await fixture.enqueueNew({ prNumber: 10, headSha: sha("b") });
    expect((await fixture.queue.get(old.id))?.status).toBe("superseded");

    for (const id of [finished.id, failed.id, cancelled.id, old.id])
      expect(
        await fixture.queue.claimNext("dispatcher-b", undefined, {
          jobId: id,
        }),
      ).toBeNull();
  });

  // #322-T02
  it("answers nothing while another job of the same pull request runs", async () => {
    const fixture = await start();
    await fixture.seedHistoricalJob({
      command: "review",
      status: "running",
      prNumber: 7,
      leaseExpiresAt: new Date(
        fixture.clock.now().getTime() + 10 * MINUTE,
      ).toISOString(),
    });
    const waiting = await fixture.seedHistoricalJob({
      command: "review",
      status: "queued",
      prNumber: 7,
      headSha: sha("b"),
    });

    expect(
      await fixture.queue.claimNext("dispatcher-a", undefined, {
        jobId: waiting.id,
      }),
    ).toBeNull();
  });

  // #322-T03
  it("gives a job to one of two claims for the same id and 204 to the other", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew();

    const answers = await Promise.all([
      fixture.queue.claimNext("dispatcher-a", undefined, {
        workerCredential: true,
        jobId: job.id,
      }),
      fixture.queue.claimNext("dispatcher-b", undefined, {
        workerCredential: true,
        jobId: job.id,
      }),
    ]);

    expect(answers.filter((answer) => answer !== null)).toHaveLength(1);
    const winner = answers.find((answer) => answer !== null);
    expect((await fixture.queue.get(job.id))?.runnerId).toBe(
      winner?.job.runnerId,
    );
  });

  // #322-T04
  it("does not give a Dynamic job to a caller that advertises only pr-agent", async () => {
    const fixture = await start({ dynamicReview: true });
    const dynamic = await fixture.seedHistoricalJob({
      command: "review",
      status: "queued",
      reviewKind: "dynamic",
    });

    expect(
      await fixture.queue.claimNext("dispatcher-a", ["pr-agent"], {
        jobId: dynamic.id,
      }),
    ).toBeNull();
    expect((await fixture.queue.get(dynamic.id))?.status).toBe("queued");
    expect((await fixture.queue.get(dynamic.id))?.attempts).toBe(0);
    const claimed = await fixture.queue.claimNext(
      "dispatcher-a",
      ["pr-agent", "opencode"],
      { jobId: dynamic.id },
    );
    expect(claimed?.job.id).toBe(dynamic.id);
  });

  // #322-T04
  it("does not give a diff job to a caller that advertises only opencode", async () => {
    const fixture = await start({ dynamicReview: true });
    const job = await fixture.enqueueNew();

    expect(
      await fixture.queue.claimNext("dispatcher-a", ["opencode"], {
        jobId: job.id,
      }),
    ).toBeNull();
  });
});

describe("the pool cap", () => {
  async function start() {
    const database = await open();
    return createJobQueueFixture(database === undefined ? {} : { database });
  }

  async function enqueueMany(
    fixture: Awaited<ReturnType<typeof start>>,
    count: number,
  ) {
    const jobs = [];
    for (let index = 0; index < count; index += 1) {
      fixture.clock.advance(1000);
      jobs.push(
        await fixture.enqueueNew({
          prNumber: 100 + index,
          headSha: sha("a"),
        }),
      );
    }
    return jobs;
  }

  // #322-T05
  it("answers nothing at the cap, claims again below it, and leaves another pool alone", async () => {
    const fixture = await start();
    await enqueueMany(fixture, 5);
    const options = { workerCredential: true, maxRunning: 2 };

    const one = await fixture.queue.claimNext("pool-a", undefined, options);
    const two = await fixture.queue.claimNext("pool-a", undefined, options);
    const three = await fixture.queue.claimNext("pool-a", undefined, options);

    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(three).toBeNull();
    // Another pool counts its own jobs only.
    expect(
      await fixture.queue.claimNext("pool-b", undefined, options),
    ).not.toBeNull();
    // A caller without a cap is not held back by the count.
    expect(await fixture.queue.claimNext("pool-a")).not.toBeNull();

    // A job that finishes frees a slot of its pool (the count is of running jobs).
    await fixture.queue.complete(one?.job.id ?? "", one?.leaseToken ?? "", {
      ok: true,
      result: {},
    });
    // pool-a now runs two (two + the uncapped one): still at the cap.
    expect(
      await fixture.queue.claimNext("pool-a", undefined, options),
    ).toBeNull();
    await fixture.queue.complete(two?.job.id ?? "", two?.leaseToken ?? "", {
      ok: true,
      result: {},
    });
    expect(
      await fixture.queue.claimNext("pool-a", undefined, options),
    ).not.toBeNull();
  });

  // #322-T05
  it("does not count a job whose lease ran out", async () => {
    const fixture = await start();
    await enqueueMany(fixture, 2);
    const options = { maxRunning: 1 };
    await fixture.queue.claimNext("pool-a", undefined, options);
    expect(
      await fixture.queue.claimNext("pool-a", undefined, options),
    ).toBeNull();

    fixture.clock.advance(3 * MINUTE);

    // The lapsed lease is dealt with first, so the slot is free again.
    expect(
      await fixture.queue.claimNext("pool-a", undefined, options),
    ).not.toBeNull();
  });

  // #322-T05
  it("applies the cap together with a job id", async () => {
    const fixture = await start();
    const [first, second] = await enqueueMany(fixture, 2);
    const options = { maxRunning: 1 };
    await fixture.queue.claimNext("pool-a", undefined, {
      ...options,
      jobId: first?.id ?? "",
    });

    expect(
      await fixture.queue.claimNext("pool-a", undefined, {
        ...options,
        jobId: second?.id ?? "",
      }),
    ).toBeNull();
    expect((await fixture.queue.get(second?.id ?? ""))?.status).toBe("queued");
  });

  // #322-T06
  it("never runs more jobs in a pool than the cap when claims arrive at the same time", async () => {
    const fixture = await start();
    await enqueueMany(fixture, 10);

    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        fixture.queue.claimNext("pool-a", undefined, {
          workerCredential: true,
          maxRunning: 3,
        }),
      ),
    );

    expect(answers.filter((answer) => answer !== null)).toHaveLength(3);
    const running = await fixture.queue.list({ status: "running" });
    expect(running).toHaveLength(3);
    expect(running.every((job) => job.runnerId === "pool-a")).toBe(true);
  });

  // #322-T06
  it("keeps each pool at its own cap when two pools claim at the same time", async () => {
    const fixture = await start();
    await enqueueMany(fixture, 12);

    const answers = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        fixture.queue.claimNext(
          index % 2 === 0 ? "pool-a" : "pool-b",
          undefined,
          {
            maxRunning: 2,
          },
        ),
      ),
    );

    expect(answers.filter((answer) => answer !== null)).toHaveLength(4);
    const running = await fixture.queue.list({ status: "running" });
    expect(running.filter((job) => job.runnerId === "pool-a")).toHaveLength(2);
    expect(running.filter((job) => job.runnerId === "pool-b")).toHaveLength(2);
  });

  // #322-T10
  it("claims as before without the new fields", async () => {
    const fixture = await start();
    const jobs = await enqueueMany(fixture, 3);

    for (const job of jobs) {
      const claimed = await fixture.queue.claimNext("runner-a");
      expect(claimed?.job.id).toBe(job.id);
    }
    expect(await fixture.queue.claimNext("runner-a")).toBeNull();
  });
});
