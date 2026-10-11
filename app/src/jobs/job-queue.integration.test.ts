// Pins down the job queue against a real SQLite file: what enqueueing stores and when it refuses to
// create a second job, what a runner is handed and in which order, how leases and runtimes run out,
// and how a job is finished. Concurrent callers (two processes) are in
// job-queue-concurrency.integration.test.ts.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { SLOT_HOLDING_STATUSES } from "./job-status.ts";
import { JobQueueError } from "./errors.ts";
import { createJobQueueFixture, sha, T0 } from "../test-support/jobs.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe("enqueueing a job", () => {
  // CR-27-T01
  it("stores a waiting job with every field that was passed and a run-after time", async () => {
    const fixture = await createJobQueueFixture();

    const result = await fixture.enqueue({
      prNumber: 7,
      prUrl: "https://github.test/acme/widgets/pull/7",
      headSha: sha("a"),
      command: "review",
      triggerKind: "webhook",
      actorLogin: "octocat",
      deliveryId: "delivery-1",
    });

    expect(result.status).toBe("created");
    const stored = await fixture.queue.get(result.job.id);
    expect(stored).toEqual({
      id: result.job.id,
      workspaceId: fixture.workspaceId,
      repositoryId: fixture.repositoryId,
      prNumber: 7,
      prUrl: "https://github.test/acme/widgets/pull/7",
      headSha: sha("a"),
      command: "review",
      args: "",
      triggerKind: "webhook",
      actorLogin: "octocat",
      deliveryId: "delivery-1",
      status: "queued",
      runAfter: T0.toISOString(),
      attempts: 0,
      runnerId: null,
      claimedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      result: null,
      errorCode: null,
      supersededBy: null,
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
      finishedAt: null,
    });
  });

  it("keeps the arguments of a comment command and a later run-after time", async () => {
    const fixture = await createJobQueueFixture();
    const runAfter = new Date(T0.getTime() + 90 * SECOND);

    const job = await fixture.enqueueNew({
      triggerKind: "comment",
      command: "ask",
      args: "why is this loop quadratic?",
      runAfter,
    });

    expect(job).toMatchObject({
      command: "ask",
      args: "why is this loop quadratic?",
      triggerKind: "comment",
      runAfter: runAfter.toISOString(),
    });
  });

  // CR-27-T12
  it("rejects an invalid head commit or command with the field named and writes nothing", async () => {
    const fixture = await createJobQueueFixture();

    const badSha = fixture.enqueue({ headSha: "not-a-sha" });
    const badCommand = fixture.enqueue({ command: "" as never });

    await expect(badSha).rejects.toMatchObject({
      name: "JobQueueError",
      code: "JOB_INPUT_INVALID",
      fieldErrors: [{ field: "headSha", code: "invalid" }],
    });
    await expect(badCommand).rejects.toBeInstanceOf(JobQueueError);
    await expect(badCommand).rejects.toMatchObject({
      fieldErrors: [{ field: "command", code: "required" }],
    });
    expect(await fixture.queue.list()).toEqual([]);
  });

  it("refuses a repository that does not exist with a stable code and writes nothing", async () => {
    const fixture = await createJobQueueFixture();

    await expect(
      fixture.enqueue({ repositoryId: "no-such-repository" }),
    ).rejects.toMatchObject({ code: "JOB_REPOSITORY_UNKNOWN" });
    expect(await fixture.queue.list()).toEqual([]);
  });
});

describe("handing a job to a runner", () => {
  // CR-27-T02
  it("gives the oldest due job and records who holds it and until when", async () => {
    const fixture = await createJobQueueFixture();
    const oldest = await fixture.enqueueNew({ prNumber: 1 });
    fixture.clock.advance(SECOND);
    await fixture.enqueueNew({ prNumber: 2 });
    fixture.clock.advance(SECOND);
    await fixture.enqueueNew({ prNumber: 3 });
    fixture.clock.advance(MINUTE);

    const claimed = await fixture.queue.claimNext("runner-a");

    expect(claimed?.job).toMatchObject({
      id: oldest.id,
      status: "running",
      runnerId: "runner-a",
      claimedAt: fixture.clock.now().toISOString(),
      heartbeatAt: fixture.clock.now().toISOString(),
      leaseExpiresAt: new Date(
        fixture.clock.now().getTime() + 2 * MINUTE,
      ).toISOString(),
      attempts: 0,
    });
    expect((await fixture.queue.get(oldest.id))?.status).toBe("running");
  });

  // CR-27-T03
  it("hands out nothing when there are no jobs", async () => {
    const fixture = await createJobQueueFixture();

    expect(await fixture.queue.claimNext("runner-a")).toBeNull();
  });

  // CR-27-T03
  it("holds a job back until its run-after time and hands it out from then on", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({
      runAfter: new Date(T0.getTime() + 90 * SECOND),
    });

    fixture.clock.set(new Date(T0.getTime() + 89 * SECOND + 999));
    expect(await fixture.queue.claimNext("runner-a")).toBeNull();
    fixture.clock.set(new Date(T0.getTime() + 90 * SECOND));
    const claimed = await fixture.queue.claimNext("runner-a");

    expect(claimed?.job.id).toBe(job.id);
  });

  it("hands out a due job even when an older one is not due yet", async () => {
    const fixture = await createJobQueueFixture();
    await fixture.enqueueNew({
      prNumber: 1,
      runAfter: new Date(T0.getTime() + 90 * SECOND),
    });
    fixture.clock.advance(SECOND);
    const due = await fixture.enqueueNew({ prNumber: 2 });

    const claimed = await fixture.queue.claimNext("runner-a");

    expect(claimed?.job.id).toBe(due.id);
  });

  // CR-27-T05
  it("never runs two jobs of one pull request at once: another pull request goes first", async () => {
    const fixture = await createJobQueueFixture();
    const running = await fixture.enqueueNew({
      prNumber: 7,
      headSha: sha("a"),
    });
    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(
      running.id,
    );
    fixture.clock.advance(SECOND);
    await fixture.enqueueNew({ prNumber: 7, headSha: sha("b") });
    fixture.clock.advance(SECOND);
    const other = await fixture.enqueueNew({ prNumber: 8 });

    const claimed = await fixture.queue.claimNext("runner-b");

    expect(claimed?.job.id).toBe(other.id);
    expect(await fixture.queue.claimNext("runner-c")).toBeNull();
  });

  it("treats the same number in another repository as another pull request", async () => {
    const fixture = await createJobQueueFixture();
    await fixture.enqueueNew({ prNumber: 7 });
    await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(SECOND);
    const other = await fixture.enqueueNew({
      prNumber: 7,
      repositoryId: fixture.otherRepositoryId,
    });

    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(other.id);
  });

  it("hands out the waiting job of a pull request as soon as its running job has finished", async () => {
    const fixture = await createJobQueueFixture();
    const first = await fixture.enqueueNew({ headSha: sha("a") });
    await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(SECOND);
    const second = await fixture.enqueueNew({ headSha: sha("b") });
    await fixture.queue.complete(first.id, await fixture.tokenOf(first.id), {
      ok: true,
      result: {},
    });

    const claimed = await fixture.queue.claimNext("runner-a");

    expect(claimed?.job.id).toBe(second.id);
  });
});

describe("replacing and deduplicating jobs", () => {
  // CR-27-T06
  it("replaces a waiting job with a newer one for the same pull request and marks it superseded", async () => {
    const fixture = await createJobQueueFixture();
    const old = await fixture.enqueueNew({ headSha: sha("a") });
    fixture.clock.advance(SECOND);

    const result = await fixture.enqueue({ headSha: sha("b") });

    expect(result).toMatchObject({
      status: "created",
      supersededJobIds: [old.id],
    });
    if (result.status !== "created") throw new Error("unreachable");
    expect(await fixture.queue.get(old.id)).toMatchObject({
      status: "superseded",
      supersededBy: result.job.id,
      finishedAt: fixture.clock.now().toISOString(),
    });
    expect(result.job.status).toBe("queued");
    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(
      result.job.id,
    );
    expect(await fixture.queue.claimNext("runner-b")).toBeNull();
  });

  it("replaces only waiting jobs of the same command on the same pull request", async () => {
    const fixture = await createJobQueueFixture();
    const otherPr = await fixture.enqueueNew({ prNumber: 8 });
    const otherRepository = await fixture.enqueueNew({
      repositoryId: fixture.otherRepositoryId,
    });
    const otherCommand = await fixture.enqueueNew({
      triggerKind: "comment",
      command: "improve",
    });
    const asked = await fixture.enqueueNew({
      triggerKind: "comment",
      command: "ask",
      args: "what?",
    });

    await fixture.enqueueNew({ headSha: sha("b") });

    for (const job of [otherPr, otherRepository, otherCommand, asked])
      expect((await fixture.queue.get(job.id))?.status).toBe("queued");
  });

  // CR-27-T07
  it("leaves a running job alone when a newer commit arrives and queues the new job behind it", async () => {
    const fixture = await createJobQueueFixture();
    const running = await fixture.enqueueNew({ headSha: sha("a") });
    const claimed = await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(SECOND);

    const result = await fixture.enqueue({ headSha: sha("b") });

    expect(result).toMatchObject({ status: "created", supersededJobIds: [] });
    expect(await fixture.queue.get(running.id)).toEqual(claimed?.job);
    expect(result.job.status).toBe("queued");
  });

  // CR-27-T08
  it("creates one automatic job per head commit and command, however often it is enqueued", async () => {
    const fixture = await createJobQueueFixture();
    const first = await fixture.enqueueNew({ deliveryId: "delivery-1" });

    const again = await fixture.enqueue({ deliveryId: "delivery-2" });

    expect(again).toMatchObject({ status: "existing", reason: "same_head" });
    expect(again.job.id).toBe(first.id);
    expect(await fixture.queue.list()).toHaveLength(1);
  });

  // CR-27-T08
  it("keeps it at one automatic job while the first runs and after it has finished or failed", async () => {
    const fixture = await createJobQueueFixture();
    const first = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");
    expect(await fixture.enqueue({})).toMatchObject({ reason: "same_head" });
    await fixture.queue.complete(first.id, await fixture.tokenOf(first.id), {
      ok: false,
      errorCode: "llm_unavailable",
    });

    expect(await fixture.enqueue({})).toMatchObject({
      status: "existing",
      reason: "same_head",
    });
    expect(await fixture.queue.list()).toHaveLength(1);
  });

  it("allows an automatic job again for a head commit whose job was replaced or cancelled", async () => {
    const fixture = await createJobQueueFixture();
    const replaced = await fixture.enqueueNew({ headSha: sha("a") });
    await fixture.enqueueNew({ headSha: sha("b") });
    expect((await fixture.queue.get(replaced.id))?.status).toBe("superseded");

    const again = await fixture.enqueue({ headSha: sha("a") });

    expect(again.status).toBe("created");

    await fixture.queue.discardWaitingForPr(fixture.repositoryId, 7);
    const afterClose = await fixture.enqueue({ headSha: sha("a") });
    expect(afterClose.status).toBe("created");
  });

  // CR-27-T09
  it("creates a job for another command on the same head commit", async () => {
    const fixture = await createJobQueueFixture();
    await fixture.enqueueNew({ command: "review", prNumber: 7 });

    const result = await fixture.enqueue({
      command: "improve",
      triggerKind: "webhook",
    });

    expect(result.status).toBe("created");
    expect(await fixture.queue.list()).toHaveLength(2);
  });

  // CR-27-T09
  it("creates a manual job for a head commit that already has a finished automatic job", async () => {
    const fixture = await createJobQueueFixture();
    const automatic = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");
    await fixture.queue.complete(
      automatic.id,
      await fixture.tokenOf(automatic.id),
      {
        ok: true,
        result: {},
      },
    );

    const manual = await fixture.enqueue({ triggerKind: "manual" });
    const comment = await fixture.enqueue({
      triggerKind: "comment",
      deliveryId: "delivery-9",
    });

    expect(manual.status).toBe("created");
    // The comment finds the waiting manual job: a person never gets a duplicate.
    expect(comment).toMatchObject({
      status: "existing",
      reason: "already_active",
    });
    expect(comment.job.id).toBe(manual.job.id);
  });

  it("returns the waiting or running job instead of creating a second one for a manual start", async () => {
    const fixture = await createJobQueueFixture();
    const waiting = await fixture.enqueueNew({ headSha: sha("a") });

    const whileWaiting = await fixture.enqueue({
      triggerKind: "manual",
      headSha: sha("b"),
    });
    await fixture.queue.claimNext("runner-a");
    const whileRunning = await fixture.enqueue({
      triggerKind: "manual",
      headSha: sha("b"),
    });

    expect(whileWaiting).toMatchObject({
      status: "existing",
      reason: "already_active",
    });
    expect(whileRunning).toMatchObject({
      status: "existing",
      reason: "already_active",
    });
    expect([whileWaiting.job.id, whileRunning.job.id]).toEqual([
      waiting.id,
      waiting.id,
    ]);
    expect(await fixture.queue.list()).toHaveLength(1);
  });

  it("starts a manual job at once and does not supersede anything", async () => {
    const fixture = await createJobQueueFixture();

    const manual = await fixture.enqueueNew({ triggerKind: "manual" });

    expect(manual.runAfter).toBe(T0.toISOString());
    const next = await fixture.enqueue({
      triggerKind: "manual",
      command: "improve",
    });
    expect(next).toMatchObject({ status: "created", supersededJobIds: [] });
  });

  it("treats different questions to /ask as different jobs", async () => {
    const fixture = await createJobQueueFixture();
    const first = await fixture.enqueueNew({
      triggerKind: "comment",
      command: "ask",
      args: "why?",
    });

    const other = await fixture.enqueue({
      triggerKind: "comment",
      command: "ask",
      args: "how?",
    });
    const same = await fixture.enqueue({
      triggerKind: "comment",
      command: "ask",
      args: "why?",
    });

    expect(other.status).toBe("created");
    expect(same).toMatchObject({
      status: "existing",
      reason: "already_active",
    });
    expect(same.job.id).toBe(first.id);
  });

  it("returns the job of a delivery that was enqueued before, even if the pull request moved on", async () => {
    const fixture = await createJobQueueFixture();
    const first = await fixture.enqueueNew({ deliveryId: "delivery-1" });
    await fixture.enqueueNew({ headSha: sha("b"), deliveryId: "delivery-2" });

    const redelivered = await fixture.enqueue({ deliveryId: "delivery-1" });

    expect(redelivered).toMatchObject({
      status: "existing",
      reason: "same_delivery",
    });
    expect(redelivered.job.id).toBe(first.id);
    expect(await fixture.queue.list()).toHaveLength(2);
  });

  it("lets the database itself refuse a second job for one delivery, one automatic head commit or one running pull request", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({ deliveryId: "delivery-1" });
    await fixture.queue.claimNext("runner-a");
    const row = await fixture.db
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    const insert = (overrides: Partial<typeof row>) =>
      fixture.db
        .insertInto("jobs")
        .values({ ...row, id: crypto.randomUUID(), ...overrides })
        .execute();

    await expect(
      insert({ status: "queued", head_sha: sha("c") }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("jobs.delivery_id"),
    });
    await expect(
      insert({ status: "queued", delivery_id: "delivery-2" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "jobs.repository_id, jobs.pr_number, jobs.head_sha",
      ),
    });
    await expect(
      insert({
        status: "running",
        delivery_id: "delivery-3",
        head_sha: sha("c"),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("jobs.repository_id, jobs.pr_number"),
    });
  });
});

describe("leases that run out", () => {
  // CR-27-T10
  it("hands a job whose lease ran out to the next runner, counts the lost attempt and drops the old holder", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    const first = await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(2 * MINUTE);

    const claimed = await fixture.queue.claimNext("runner-b");

    expect(claimed?.job).toMatchObject({
      id: job.id,
      status: "running",
      runnerId: "runner-b",
      attempts: 1,
      claimedAt: fixture.clock.now().toISOString(),
    });
    expect(claimed?.leaseToken).not.toBe(first?.leaseToken);
    expect(
      await fixture.queue.heartbeat(job.id, first?.leaseToken ?? ""),
    ).toEqual({ status: "not_holder" });
    expect(
      await fixture.queue.complete(job.id, first?.leaseToken ?? "", {
        ok: true,
        result: {},
      }),
    ).toEqual({ status: "not_holder" });
    expect(await fixture.queue.claimNext("runner-c")).toBeNull();
  });

  it("keeps a job with a live lease and reserves it for its runner", async () => {
    const fixture = await createJobQueueFixture();
    await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(2 * MINUTE - 1);

    expect(await fixture.queue.claimNext("runner-b")).toBeNull();
  });

  it("keeps a job alive for as long as its runner sends heartbeats", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");

    for (let beat = 0; beat < 6; beat++) {
      fixture.clock.advance(90 * SECOND);
      const result = await fixture.queue.heartbeat(
        job.id,
        await fixture.tokenOf(job.id),
      );
      expect(result).toMatchObject({
        status: "ok",
        job: {
          heartbeatAt: fixture.clock.now().toISOString(),
          leaseExpiresAt: new Date(
            fixture.clock.now().getTime() + 2 * MINUTE,
          ).toISOString(),
        },
      });
      expect(await fixture.queue.claimNext("runner-b")).toBeNull();
    }
    expect((await fixture.queue.get(job.id))?.attempts).toBe(0);
  });

  // CR-27-T11
  it("fails a job with lease_expired when the lease runs out on the last allowed attempt and never hands it out again", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});

    for (const runner of ["runner-a", "runner-b", "runner-c"]) {
      expect((await fixture.queue.claimNext(runner))?.job.id).toBe(job.id);
      fixture.clock.advance(3 * MINUTE);
    }
    const report = await fixture.queue.expireStaleJobs();

    expect(report).toEqual({ requeued: 0, leaseExpired: 1, timedOut: 0 });
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
      attempts: 3,
      finishedAt: fixture.clock.now().toISOString(),
    });
    expect(await fixture.queue.claimNext("runner-d")).toBeNull();
    expect(
      await fixture.queue.complete(job.id, await fixture.tokenOf(job.id), {
        ok: true,
        result: {},
      }),
    ).toMatchObject({ status: "outcome_conflict" });
  });

  // CR-27-T11
  it("runs the expiry check at claim time, so the claim that finds the last lost lease fails the job", async () => {
    const fixture = await createJobQueueFixture({ limits: { maxAttempts: 2 } });
    const job = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(3 * MINUTE);
    await fixture.queue.claimNext("runner-b");
    fixture.clock.advance(3 * MINUTE);

    const claimed = await fixture.queue.claimNext("runner-c");

    expect(claimed).toBeNull();
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
      attempts: 2,
    });
  });

  it("lets the next job of the pull request run after one failed on its lost lease", async () => {
    const fixture = await createJobQueueFixture({ limits: { maxAttempts: 1 } });
    await fixture.enqueueNew({ headSha: sha("a") });
    await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(SECOND);
    const next = await fixture.enqueueNew({ headSha: sha("b") });
    fixture.clock.advance(3 * MINUTE);

    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(next.id);
  });

  it("fails a job that runs longer than the hard limit even though its runner keeps sending heartbeats", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");

    for (let minute = 1; minute <= 24; minute++) {
      fixture.clock.advance(MINUTE);
      await fixture.queue.heartbeat(job.id, await fixture.tokenOf(job.id));
      expect(await fixture.queue.claimNext("runner-b")).toBeNull();
    }
    expect((await fixture.queue.get(job.id))?.status).toBe("running");
    fixture.clock.advance(MINUTE);
    await fixture.queue.heartbeat(job.id, await fixture.tokenOf(job.id));

    expect(await fixture.queue.claimNext("runner-b")).toBeNull();
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
      finishedAt: fixture.clock.now().toISOString(),
    });
    expect(
      await fixture.queue.heartbeat(job.id, await fixture.tokenOf(job.id)),
    ).toEqual({
      status: "not_holder",
    });
  });

  it("counts the runtime from the latest claim, not from the first one", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(20 * MINUTE);
    // The first runner vanished 18 minutes ago; its job goes to the second runner.
    await fixture.queue.claimNext("runner-b");
    fixture.clock.advance(10 * MINUTE);
    await fixture.queue.heartbeat(job.id, await fixture.tokenOf(job.id));

    await fixture.queue.claimNext("runner-c");

    expect((await fixture.queue.get(job.id))?.status).toBe("running");
  });

  it("makes a limit configurable", async () => {
    const fixture = await createJobQueueFixture({
      limits: { leaseMs: 10 * SECOND, maxRuntimeMs: 30 * SECOND },
    });
    const job = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(11 * SECOND);

    const claimed = await fixture.queue.claimNext("runner-b");

    expect(claimed?.job).toMatchObject({
      id: job.id,
      leaseExpiresAt: new Date(
        fixture.clock.now().getTime() + 10 * SECOND,
      ).toISOString(),
    });
  });
});

describe("finishing a job", () => {
  it("marks the job succeeded and stores the result", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(MINUTE);

    const completed = await fixture.queue.complete(
      job.id,
      await fixture.tokenOf(job.id),
      {
        ok: true,
        result: { commentUrl: "https://github.test/c/1", durationMs: 4200 },
      },
    );

    expect(completed).toMatchObject({
      status: "completed",
      job: {
        status: "succeeded",
        result: { commentUrl: "https://github.test/c/1", durationMs: 4200 },
        errorCode: null,
        leaseExpiresAt: null,
        finishedAt: fixture.clock.now().toISOString(),
      },
    });
  });

  it("marks the job failed with the code the runner reported", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");

    const completed = await fixture.queue.complete(
      job.id,
      await fixture.tokenOf(job.id),
      {
        ok: false,
        errorCode: "llm_output_invalid",
        result: { logTail: "..." },
      },
    );

    expect(completed).toMatchObject({
      status: "completed",
      job: {
        status: "failed",
        errorCode: "llm_output_invalid",
        result: { logTail: "..." },
      },
    });
  });

  it("answers the same way when the same outcome is reported again", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");
    const outcome = { ok: true as const, result: { a: 1, b: [1, 2] } };
    await fixture.queue.complete(
      job.id,
      await fixture.tokenOf(job.id),
      outcome,
    );
    const before = await fixture.queue.get(job.id);

    const again = await fixture.queue.complete(
      job.id,
      await fixture.tokenOf(job.id),
      {
        ok: true,
        result: { b: [1, 2], a: 1 },
      },
    );

    expect(again).toMatchObject({ status: "already_completed" });
    expect(await fixture.queue.get(job.id)).toEqual(before);
  });

  it("refuses a different outcome for a job that is already finished", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");
    await fixture.queue.complete(job.id, await fixture.tokenOf(job.id), {
      ok: true,
      result: { a: 1 },
    });

    const other = await fixture.queue.complete(
      job.id,
      await fixture.tokenOf(job.id),
      {
        ok: true,
        result: { a: 2 },
      },
    );
    const failure = await fixture.queue.complete(
      job.id,
      await fixture.tokenOf(job.id),
      {
        ok: false,
        errorCode: "x",
      },
    );

    expect(other).toMatchObject({ status: "outcome_conflict" });
    expect(failure).toMatchObject({ status: "outcome_conflict" });
    expect((await fixture.queue.get(job.id))?.result).toEqual({ a: 1 });
  });

  it("refuses a token that is not the current claim, a job that waits and one that does not exist", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    const outcome = { ok: true as const, result: {} };

    expect(await fixture.queue.complete(job.id, "some-token", outcome)).toEqual(
      {
        status: "not_holder",
      },
    );
    const claimed = await fixture.queue.claimNext("runner-a");
    expect(await fixture.queue.complete(job.id, "some-token", outcome)).toEqual(
      {
        status: "not_holder",
      },
    );
    expect(
      await fixture.queue.complete(
        "missing",
        claimed?.leaseToken ?? "",
        outcome,
      ),
    ).toEqual({ status: "not_holder" });
    expect(await fixture.queue.heartbeat(job.id, "some-token")).toEqual({
      status: "not_holder",
    });
    expect((await fixture.queue.get(job.id))?.status).toBe("running");
  });

  it("still accepts the result of a runner whose lease ran out but whose job nobody has taken yet", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(5 * MINUTE);

    const completed = await fixture.queue.complete(
      job.id,
      await fixture.tokenOf(job.id),
      {
        ok: true,
        result: {},
      },
    );

    expect(completed).toMatchObject({ status: "completed" });
  });
});

describe("dropping waiting jobs", () => {
  it("cancels every waiting job of a repository and leaves running and other jobs alone", async () => {
    const fixture = await createJobQueueFixture();
    const running = await fixture.enqueueNew({ prNumber: 1 });
    await fixture.queue.claimNext("runner-a");
    const waitingOne = await fixture.enqueueNew({
      prNumber: 1,
      headSha: sha("b"),
    });
    const waitingTwo = await fixture.enqueueNew({ prNumber: 2 });
    const elsewhere = await fixture.enqueueNew({
      repositoryId: fixture.otherRepositoryId,
    });
    fixture.clock.advance(SECOND);

    const cancelled = await fixture.queue.cancelWaitingForRepository(
      fixture.repositoryId,
    );

    expect(cancelled).toBe(2);
    expect((await fixture.queue.get(running.id))?.status).toBe("running");
    for (const job of [waitingOne, waitingTwo])
      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "cancelled",
        errorCode: "project_deactivated",
        finishedAt: fixture.clock.now().toISOString(),
      });
    expect((await fixture.queue.get(elsewhere.id))?.status).toBe("queued");
    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(
      elsewhere.id,
    );
  });

  it("cancels only the waiting automatic jobs of a pull request that became a draft", async () => {
    const fixture = await createJobQueueFixture();
    const automatic = await fixture.enqueueNew({
      prNumber: 7,
      headSha: sha("a"),
    });
    const asked = await fixture.enqueueNew({
      prNumber: 7,
      command: "ask",
      args: "why?",
      triggerKind: "comment",
    });
    const otherPullRequest = await fixture.enqueueNew({
      prNumber: 8,
      headSha: sha("b"),
    });

    const discarded = await fixture.queue.discardWaitingAutomaticForPr(
      fixture.repositoryId,
      7,
    );

    expect(discarded).toBe(1);
    expect(await fixture.queue.get(automatic.id)).toMatchObject({
      status: "cancelled",
      errorCode: "pull_request_draft",
    });
    expect((await fixture.queue.get(asked.id))?.status).toBe("queued");
    expect((await fixture.queue.get(otherPullRequest.id))?.status).toBe(
      "queued",
    );
  });

  it("cancels the waiting jobs of one pull request and lets its running job finish", async () => {
    const fixture = await createJobQueueFixture();
    const running = await fixture.enqueueNew({
      prNumber: 7,
      headSha: sha("a"),
    });
    await fixture.queue.claimNext("runner-a");
    const waiting = await fixture.enqueueNew({
      prNumber: 7,
      headSha: sha("b"),
    });
    const improve = await fixture.enqueueNew({
      prNumber: 7,
      command: "improve",
      triggerKind: "comment",
    });
    const other = await fixture.enqueueNew({ prNumber: 8 });

    const discarded = await fixture.queue.discardWaitingForPr(
      fixture.repositoryId,
      7,
    );

    expect(discarded).toBe(2);
    expect((await fixture.queue.get(running.id))?.status).toBe("running");
    for (const job of [waiting, improve])
      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "cancelled",
        errorCode: "pull_request_closed",
      });
    expect((await fixture.queue.get(other.id))?.status).toBe("queued");
    expect(
      await fixture.queue.complete(
        running.id,
        await fixture.tokenOf(running.id),
        {
          ok: true,
          result: {},
        },
      ),
    ).toMatchObject({ status: "completed" });
  });

  // CR-46-T01
  it("cancels a claimed job in one step for the holder of the claim, on any attempt, without queuing it again", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew();
    await fixture.db
      .updateTable("jobs")
      .set({ attempts: 2 })
      .where("id", "=", job.id)
      .execute();
    const claimed = await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(SECOND);

    const result = await fixture.queue.cancelClaimed(
      job.id,
      claimed!.leaseToken,
      "project_deactivated",
    );

    expect(result).toMatchObject({
      status: "cancelled",
      job: {
        status: "cancelled",
        errorCode: "project_deactivated",
        attempts: 2,
        leaseExpiresAt: null,
        finishedAt: fixture.clock.now().toISOString(),
      },
    });
    // It frees the slot of the head commit, like any cancelled job.
    expect((await fixture.enqueue({ headSha: job.headSha })).status).toBe(
      "created",
    );
  });

  // CR-46-T01
  it("refuses to cancel a job for a caller that does not hold it, and a job that is not running", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew();

    expect(
      await fixture.queue.cancelClaimed(
        job.id,
        "no-such-token",
        "project_deactivated",
      ),
    ).toStrictEqual({ status: "not_holder" });
    const claimed = await fixture.queue.claimNext("runner-a");
    expect(
      await fixture.queue.cancelClaimed(
        job.id,
        "stale-token",
        "project_deactivated",
      ),
    ).toStrictEqual({ status: "not_holder" });
    expect((await fixture.queue.get(job.id))?.status).toBe("running");
    await fixture.queue.complete(job.id, claimed!.leaseToken, {
      ok: true,
      result: {},
    });
    expect(
      await fixture.queue.cancelClaimed(
        job.id,
        claimed!.leaseToken,
        "project_deactivated",
      ),
    ).toStrictEqual({ status: "not_holder" });
    expect((await fixture.queue.get(job.id))?.status).toBe("succeeded");
  });

  it("does nothing when nothing waits", async () => {
    const fixture = await createJobQueueFixture();

    expect(
      await fixture.queue.cancelWaitingForRepository(fixture.repositoryId),
    ).toBe(0);
    expect(
      await fixture.queue.discardWaitingForPr(fixture.repositoryId, 7),
    ).toBe(0);
  });
});

describe("listing jobs", () => {
  it("filters by repository, pull request and status", async () => {
    const fixture = await createJobQueueFixture();
    const a = await fixture.enqueueNew({ prNumber: 1 });
    fixture.clock.advance(SECOND);
    const b = await fixture.enqueueNew({ prNumber: 2 });
    fixture.clock.advance(SECOND);
    const c = await fixture.enqueueNew({
      repositoryId: fixture.otherRepositoryId,
    });
    await fixture.queue.claimNext("runner-a");

    const ids = async (filter: Parameters<typeof fixture.queue.list>[0]) =>
      (await fixture.queue.list(filter)).map((job) => job.id);

    expect(await ids({})).toEqual([a.id, b.id, c.id]);
    expect(await ids({ repositoryId: fixture.repositoryId })).toEqual([
      a.id,
      b.id,
    ]);
    expect(
      await ids({ repositoryId: fixture.repositoryId, prNumber: 2 }),
    ).toEqual([b.id]);
    expect(await ids({ status: "running" })).toEqual([a.id]);
    expect(await ids({ status: ["queued", "running"] })).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
  });
});

describe("a runner that stalled and came back", () => {
  it("cannot heartbeat, complete or release the job once the same runner id holds it again under a new claim", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    const stale = await fixture.queue.claimNext("runner-a");
    // The runner stalls past its lease, then polls again under the same id.
    fixture.clock.advance(3 * MINUTE);
    const fresh = await fixture.queue.claimNext("runner-a");
    expect(fresh?.job).toMatchObject({
      id: job.id,
      runnerId: "runner-a",
      attempts: 1,
    });
    const staleToken = stale?.leaseToken ?? "";

    expect(await fixture.queue.heartbeat(job.id, staleToken)).toEqual({
      status: "not_holder",
    });
    expect(
      await fixture.queue.complete(job.id, staleToken, {
        ok: true,
        result: {},
      }),
    ).toEqual({ status: "not_holder" });
    expect(
      await fixture.queue.release(job.id, staleToken, "runner_shutdown"),
    ).toEqual({
      status: "not_holder",
    });

    // The stale execution changed nothing, and the new one is the holder.
    expect(await fixture.queue.get(job.id)).toEqual(fresh?.job);
    expect(
      await fixture.queue.heartbeat(job.id, fresh?.leaseToken ?? ""),
    ).toMatchObject({ status: "ok" });
    expect(
      await fixture.queue.complete(job.id, fresh?.leaseToken ?? "", {
        ok: true,
        result: { fresh: true },
      }),
    ).toMatchObject({ status: "completed", job: { result: { fresh: true } } });
  });

  it("is told it lost the job even when it reports after the new execution finished", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    const stale = await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(3 * MINUTE);
    const fresh = await fixture.queue.claimNext("runner-a");
    await fixture.queue.complete(job.id, fresh?.leaseToken ?? "", {
      ok: true,
      result: { fresh: true },
    });

    const late = await fixture.queue.complete(job.id, stale?.leaseToken ?? "", {
      ok: true,
      result: { fresh: false },
    });

    expect(late).toEqual({ status: "not_holder" });
    expect((await fixture.queue.get(job.id))?.result).toEqual({ fresh: true });
  });

  it("hands out a different lease token with every claim", async () => {
    const fixture = await createJobQueueFixture();
    await fixture.enqueueNew({ prNumber: 1 });
    await fixture.enqueueNew({ prNumber: 2 });

    const first = await fixture.queue.claimNext("runner-a");
    const second = await fixture.queue.claimNext("runner-a");

    expect(first?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    expect(JSON.stringify(first?.job)).not.toContain(first?.leaseToken ?? "x");
  });
});

describe("the hard limit seen from the holder", () => {
  it("fails the job with timeout on the first heartbeat after the limit and tells the holder it lost the job, without any claim", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    const claimed = await fixture.queue.claimNext("runner-a");
    fixture.clock.advance(24 * MINUTE);
    expect(
      await fixture.queue.heartbeat(job.id, claimed?.leaseToken ?? ""),
    ).toMatchObject({ status: "ok" });
    fixture.clock.advance(MINUTE);

    const beat = await fixture.queue.heartbeat(
      job.id,
      claimed?.leaseToken ?? "",
    );

    expect(beat).toEqual({ status: "not_holder" });
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
    });
  });
});

describe("giving a claimed job back", () => {
  it("puts the job back in the queue as a lost attempt and drops the holder", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    const claimed = await fixture.queue.claimNext("runner-a");

    const released = await fixture.queue.release(
      job.id,
      claimed?.leaseToken ?? "",
      "runner_shutdown",
    );

    expect(released).toMatchObject({
      status: "requeued",
      job: {
        status: "queued",
        attempts: 1,
        runnerId: null,
        claimedAt: null,
        leaseExpiresAt: null,
        errorCode: null,
      },
    });
    expect(
      await fixture.queue.heartbeat(job.id, claimed?.leaseToken ?? ""),
    ).toEqual({ status: "not_holder" });
    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(job.id);
  });

  it("holds the job back until the time given", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    const claimed = await fixture.queue.claimNext("runner-a");
    const retryAt = new Date(T0.getTime() + 30 * SECOND);

    await fixture.queue.release(
      job.id,
      claimed?.leaseToken ?? "",
      "git_unavailable",
      {
        retryAt,
      },
    );

    expect(await fixture.queue.claimNext("runner-b")).toBeNull();
    fixture.clock.set(retryAt);
    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(job.id);
  });

  it("fails the job with the given reason on the last allowed attempt, like a lapsed lease", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});

    for (let attempt = 1; attempt <= 2; attempt++) {
      const claimed = await fixture.queue.claimNext("runner-a");
      expect(
        await fixture.queue.release(
          job.id,
          claimed?.leaseToken ?? "",
          "git_unavailable",
        ),
      ).toMatchObject({ status: "requeued", job: { attempts: attempt } });
    }
    const last = await fixture.queue.claimNext("runner-a");
    const released = await fixture.queue.release(
      job.id,
      last?.leaseToken ?? "",
      "git_unavailable",
    );

    expect(released).toMatchObject({
      status: "failed",
      job: { status: "failed", errorCode: "git_unavailable", attempts: 3 },
    });
    expect(await fixture.queue.claimNext("runner-a")).toBeNull();
  });

  it("refuses a give-back without a reason and from someone who does not hold the job", async () => {
    const fixture = await createJobQueueFixture();
    const job = await fixture.enqueueNew({});
    const claimed = await fixture.queue.claimNext("runner-a");

    await expect(
      fixture.queue.release(job.id, claimed?.leaseToken ?? "", " "),
    ).rejects.toMatchObject({
      code: "JOB_INPUT_INVALID",
      fieldErrors: [{ field: "reason", code: "required" }],
    });
    expect(await fixture.queue.release(job.id, "wrong", "x")).toEqual({
      status: "not_holder",
    });
    expect((await fixture.queue.get(job.id))?.status).toBe("running");
  });
});

describe("jobs a person asked for", () => {
  it("are not replaced by a newer automatic job", async () => {
    const fixture = await createJobQueueFixture();
    const comment = await fixture.enqueueNew({
      triggerKind: "comment",
      headSha: sha("a"),
    });
    const manualImprove = await fixture.enqueueNew({
      triggerKind: "manual",
      command: "improve",
    });

    const automatic = await fixture.enqueue({ headSha: sha("b") });

    expect(automatic).toMatchObject({
      status: "created",
      supersededJobIds: [],
    });
    expect((await fixture.queue.get(comment.id))?.status).toBe("queued");
    expect((await fixture.queue.get(manualImprove.id))?.status).toBe("queued");
  });

  it("pull a waiting job that is held back by a debounce forward to now", async () => {
    const fixture = await createJobQueueFixture();
    const debounced = await fixture.enqueueNew({
      runAfter: new Date(T0.getTime() + 90 * SECOND),
    });
    fixture.clock.advance(10 * SECOND);

    const manual = await fixture.enqueue({ triggerKind: "manual" });

    expect(manual).toMatchObject({
      status: "existing",
      reason: "already_active",
      job: { id: debounced.id, runAfter: fixture.clock.now().toISOString() },
    });
    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(
      debounced.id,
    );
  });

  it("leave the run-after time of a waiting job alone when it is due already, and of a webhook duplicate", async () => {
    const fixture = await createJobQueueFixture();
    const held = await fixture.enqueueNew({
      runAfter: new Date(T0.getTime() + 90 * SECOND),
    });

    const duplicate = await fixture.enqueue({ headSha: held.headSha });

    expect(duplicate).toMatchObject({ reason: "same_head" });
    expect((await fixture.queue.get(held.id))?.runAfter).toBe(
      new Date(T0.getTime() + 90 * SECOND).toISOString(),
    );
  });
});

describe("listing jobs with a limit", () => {
  it("returns at most the limit, oldest first, and a default limit when none is given", async () => {
    const fixture = await createJobQueueFixture();
    const jobs = [];
    for (let pr = 1; pr <= 5; pr++) {
      jobs.push(await fixture.enqueueNew({ prNumber: pr }));
      fixture.clock.advance(SECOND);
    }

    const limited = await fixture.queue.list({ limit: 2 });

    expect(limited.map((job) => job.id)).toEqual([jobs[0]?.id, jobs[1]?.id]);
    expect(await fixture.queue.list()).toHaveLength(5);
    expect(await fixture.queue.list({ limit: 0 })).toHaveLength(1);
  });
});

describe("a job that comes from a comment", () => {
  async function recordedComments(
    fixture: Awaited<ReturnType<typeof createJobQueueFixture>>,
  ) {
    return fixture.db
      .selectFrom("job_comments")
      .select(["repository_id", "comment_id", "job_id"])
      .orderBy("comment_id")
      .execute();
  }

  // CR-32-T12
  it("records the comment it came from", async () => {
    const fixture = await createJobQueueFixture();

    const job = await fixture.enqueueNew({
      triggerKind: "comment",
      commentId: "99001",
    });
    await fixture.enqueueNew({ headSha: sha("b") });

    expect(await recordedComments(fixture)).toEqual([
      {
        repository_id: fixture.repositoryId,
        comment_id: "99001",
        job_id: job.id,
      },
    ]);
  });

  // CR-32-T12
  it("is not created twice for the same comment, whatever delivery brings it", async () => {
    const fixture = await createJobQueueFixture();
    const first = await fixture.enqueueNew({
      triggerKind: "comment",
      commentId: "99001",
      deliveryId: "delivery-1",
    });

    const replay = await fixture.enqueue({
      triggerKind: "comment",
      commentId: "99001",
      deliveryId: "delivery-2",
    });

    expect(replay).toMatchObject({
      status: "existing",
      reason: "same_comment",
      job: { id: first.id },
    });
    expect(await fixture.queue.list()).toHaveLength(1);
  });

  // CR-32-T12
  it("is not created again for a comment whose job has finished", async () => {
    const fixture = await createJobQueueFixture();
    const first = await fixture.enqueueNew({
      triggerKind: "comment",
      commentId: "99001",
      deliveryId: "delivery-1",
    });
    const claimed = await fixture.queue.claimNext("runner-a");
    await fixture.queue.complete(first.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {},
    });

    const replay = await fixture.enqueue({
      triggerKind: "comment",
      commentId: "99001",
      deliveryId: "delivery-2",
    });

    expect(replay).toMatchObject({
      status: "existing",
      reason: "same_comment",
      job: { id: first.id, status: "succeeded" },
    });
  });

  // CR-32-T12
  it("is recorded too when a second comment finds the same command still waiting, so its replay creates nothing later", async () => {
    const fixture = await createJobQueueFixture();
    const first = await fixture.enqueueNew({
      triggerKind: "comment",
      commentId: "99001",
    });

    const second = await fixture.enqueue({
      triggerKind: "comment",
      commentId: "99002",
    });
    const claimed = await fixture.queue.claimNext("runner-a");
    await fixture.queue.complete(first.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {},
    });
    const replayOfSecond = await fixture.enqueue({
      triggerKind: "comment",
      commentId: "99002",
    });

    expect(second).toMatchObject({
      status: "existing",
      reason: "already_active",
      job: { id: first.id },
    });
    expect(replayOfSecond).toMatchObject({
      status: "existing",
      reason: "same_comment",
      job: { id: first.id },
    });
    expect(
      (await recordedComments(fixture)).map((row) => row.comment_id),
    ).toEqual(["99001", "99002"]);
    expect(await fixture.queue.list()).toHaveLength(1);
  });

  // CR-32-T12
  it("is created for another comment asking for the same thing, once the first job has finished", async () => {
    const fixture = await createJobQueueFixture();
    const first = await fixture.enqueueNew({
      triggerKind: "comment",
      commentId: "99001",
    });
    const claimed = await fixture.queue.claimNext("runner-a");
    await fixture.queue.complete(first.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {},
    });

    const second = await fixture.enqueue({
      triggerKind: "comment",
      commentId: "99002",
    });

    expect(second.status).toBe("created");
  });

  it("is a different job for the same comment id in another repository", async () => {
    const fixture = await createJobQueueFixture();
    await fixture.enqueueNew({ triggerKind: "comment", commentId: "99001" });

    const other = await fixture.enqueue({
      triggerKind: "comment",
      commentId: "99001",
      repositoryId: fixture.otherRepositoryId,
    });

    expect(other.status).toBe("created");
  });

  it("is refused by the database too when a comment is recorded twice", async () => {
    const fixture = await createJobQueueFixture();
    const first = await fixture.enqueueNew({
      triggerKind: "comment",
      commentId: "99001",
    });

    await expect(
      fixture.db
        .insertInto("job_comments")
        .values({
          repository_id: fixture.repositoryId,
          comment_id: "99001",
          job_id: first.id,
        })
        .execute(),
    ).rejects.toThrow(/UNIQUE/);
  });
});

describe("the automatic slot index", () => {
  it("spells out the same statuses as the slot-holding statuses of the code", async () => {
    const fixture = await createJobQueueFixture();

    const { rows } = await sql<{ sql: string }>`
      select sql from sqlite_master where name = 'jobs_automatic_per_head_unique'`.execute(
      fixture.db,
    );

    const listed = [...(rows[0]?.sql.matchAll(/'([a-z]+)'/g) ?? [])]
      .map((match) => match[1])
      .filter((value) => value !== "webhook");
    expect(listed.sort()).toEqual([...SLOT_HOLDING_STATUSES].sort());
  });
});
