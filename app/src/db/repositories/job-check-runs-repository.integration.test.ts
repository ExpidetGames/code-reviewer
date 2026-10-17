// SPDX-License-Identifier: Apache-2.0

// The record of the check runs and review verdicts of the jobs of a workspace against a real SQLite file (#405):
// one row per job, taken by one caller at a time, retried a bounded number of times, and never changed once
// settled or dropped. Isolation between workspaces is in scoped-isolation.integration.test.ts; what the service does
// with the row is in src/check-runs/service.integration.test.ts.
import { describe, expect, it } from "vitest";
import { createJobQueueFixture, sha } from "../../test-support/jobs.ts";
import { createJobCheckRunsRepository } from "./job-check-runs-repository.ts";
import { listJobsWithCheckWork } from "./job-check-runs-sweep.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const LEASE = { leaseMs: MINUTE, maxAttempts: 5 };

async function setup() {
  const fixture = await createJobQueueFixture();
  // The clock of the fixture is the one of its queue, so a lease that runs out is the queue's too.
  const checks = createJobCheckRunsRepository(
    fixture.db,
    fixture.workspaceId,
    fixture.clock.now,
  );
  const job = await fixture.enqueueNew();
  return {
    ...fixture,
    checks,
    job,
    advance: (ms: number) => {
      fixture.clock.advance(ms);
    },
    now: () => fixture.clock.now(),
  };
}

describe("taking the check of a job", () => {
  // #405-T16
  it("hands a new job to the first caller only, and says the row was made by this call", async () => {
    const t = await setup();

    const first = await t.checks.take(t.job.id, LEASE);
    const second = await t.checks.take(t.job.id, LEASE);

    expect(first).toMatchObject({
      acquired: true,
      created: true,
      check: {
        jobId: t.job.id,
        workspaceId: t.workspaceId,
        checkRunId: null,
        reviewId: null,
        syncedStatus: null,
        checkCreateAttempts: 0,
        reviewSubmitAttempts: 0,
        checkState: "active",
        reviewState: "pending",
        state: "active",
        // A sync that is started counts at once, so one that is killed halfway is not forgotten.
        attempts: 1,
        lastCode: null,
      },
    });
    expect(second).toEqual({ acquired: false });
  });

  // #405-T16
  it("lets exactly one of several concurrent callers take it", async () => {
    const t = await setup();

    const results = await Promise.all(
      Array.from({ length: 6 }, () => t.checks.take(t.job.id, LEASE)),
    );

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });

  // #405-T16
  it("hands the job on again once the lease of the earlier caller is over, and says it is not new", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);
    t.advance(MINUTE + SECOND);

    const again = await t.checks.take(t.job.id, LEASE);

    expect(again).toMatchObject({ acquired: true, created: false });
  });

  it("lets the next caller in at once when the first one let go", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);
    await t.checks.finish(t.job.id, { settled: false });

    expect(await t.checks.take(t.job.id, LEASE)).toMatchObject({
      acquired: true,
      created: false,
    });
  });

  it("does not take a job that does not exist or belongs to another workspace", async () => {
    const t = await setup();

    expect(
      await t.checks.take("00000000-0000-4000-8000-000000000000", LEASE),
    ).toEqual({ acquired: false });
  });
});

describe("what a sync writes down", () => {
  // #405-T02
  it("keeps the ids and the status the check run shows", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);

    await t.checks.recordCheck(t.job.id, {
      checkRunId: "9001",
      syncedStatus: "queued",
    });
    await t.checks.recordReview(t.job.id, {
      reviewId: "5001",
      reviewState: "done",
    });

    expect(await t.checks.find(t.job.id)).toMatchObject({
      checkRunId: "9001",
      syncedStatus: "queued",
      reviewId: "5001",
      reviewState: "done",
    });
  });

  // #405-T16
  it("counts a start before the call, so a later attempt knows an earlier one may have worked", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);

    await t.checks.noteStarted(t.job.id, "check");
    await t.checks.noteStarted(t.job.id, "review");
    await t.checks.noteStarted(t.job.id, "review");

    expect(await t.checks.find(t.job.id)).toMatchObject({
      checkCreateAttempts: 1,
      reviewSubmitAttempts: 2,
    });
  });

  it("settles a row for good: it is not taken again and its fields no longer change", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);
    await t.checks.recordCheck(t.job.id, {
      checkRunId: "9001",
      syncedStatus: "succeeded",
    });
    await t.checks.finish(t.job.id, { settled: true });

    await t.checks.recordCheck(t.job.id, {
      checkRunId: "other",
      syncedStatus: "queued",
    });

    expect(await t.checks.take(t.job.id, LEASE)).toEqual({ acquired: false });
    expect(await t.checks.find(t.job.id)).toMatchObject({
      state: "settled",
      checkRunId: "9001",
      syncedStatus: "succeeded",
    });
  });
});

describe("a failed sync", () => {
  // #405-T15
  it("waits for its back-off and is taken again after it, with the failures counted", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);

    await t.checks.failed(t.job.id, {
      code: "INTEGRATION_ACCESS_UNAVAILABLE",
      retryAt: new Date(t.now().getTime() + 5 * MINUTE),
      maxAttempts: 5,
    });

    expect(await t.checks.take(t.job.id, LEASE)).toEqual({ acquired: false });
    t.advance(5 * MINUTE);
    expect(await t.checks.take(t.job.id, LEASE)).toMatchObject({
      acquired: true,
      check: { attempts: 2, lastCode: "INTEGRATION_ACCESS_UNAVAILABLE" },
    });
  });

  // #405-T15
  it("is dropped when its attempts are used up, and never taken again", async () => {
    const t = await setup();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await t.checks.take(t.job.id, { ...LEASE, maxAttempts: 3 });
      await t.checks.failed(t.job.id, {
        code: "INTEGRATION_ACCESS_UNAVAILABLE",
        retryAt: t.now(),
        maxAttempts: 3,
      });
    }

    expect(await t.checks.find(t.job.id)).toMatchObject({
      state: "dropped",
      attempts: 3,
      lastCode: "INTEGRATION_ACCESS_UNAVAILABLE",
    });
    t.advance(60 * MINUTE);
    expect(await t.checks.take(t.job.id, LEASE)).toEqual({ acquired: false });
  });

  // #405-T15 (review P2-4)
  it("counts a sync that was killed halfway, and drops the row when the syncs started pile up", async () => {
    const t = await setup();
    const options = { leaseMs: MINUTE, maxAttempts: 3 };

    // Three syncs start and never finish: no finish, no failure is ever written.
    for (let start = 0; start < 3; start += 1) {
      expect(await t.checks.take(t.job.id, options)).toMatchObject({
        acquired: true,
      });
      t.advance(MINUTE + SECOND);
    }
    const fourth = await t.checks.take(t.job.id, options);

    expect(fourth).toEqual({ acquired: false });
    expect(await t.checks.find(t.job.id)).toMatchObject({
      state: "dropped",
      attempts: 3,
    });
  });

  // #405-T15 (review P1-1)
  it("is given more attempts to close a check run that is still open, and the limit it is given is the caller's", async () => {
    const t = await setup();
    const options = { leaseMs: MINUTE, maxAttempts: 30 };

    for (let start = 0; start < 7; start += 1) {
      await t.checks.take(t.job.id, options);
      await t.checks.failed(t.job.id, {
        code: "INTEGRATION_ACCESS_UNAVAILABLE",
        retryAt: t.now(),
        maxAttempts: 30,
      });
    }

    expect(await t.checks.find(t.job.id)).toMatchObject({
      state: "active",
      attempts: 7,
    });
  });

  // #405-T16 (review P1-2)
  it("forgets the attempts to make a check run once it is known that none exists", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);
    await t.checks.noteStarted(t.job.id, "check");

    await t.checks.forgetCheckAttempts(t.job.id);

    expect(await t.checks.find(t.job.id)).toMatchObject({
      checkCreateAttempts: 0,
      checkRunId: null,
    });
  });

  // #405-T12
  it("is dropped at once for a reason no retry cures, with its code", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);

    await t.checks.drop(t.job.id, "CHECK_RUN_PERMISSION_MISSING");

    expect(await t.checks.find(t.job.id)).toMatchObject({
      state: "dropped",
      lastCode: "CHECK_RUN_PERMISSION_MISSING",
    });
    expect(await t.checks.take(t.job.id, LEASE)).toEqual({ acquired: false });
  });

  // #405-T12
  it("drops the check run alone for a missing permission, and the row stays active for the verdict", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);

    await t.checks.dropCheck(t.job.id, "CHECK_RUN_PERMISSION_MISSING");
    await t.checks.recordReview(t.job.id, {
      reviewId: "5001",
      reviewState: "done",
    });

    expect(await t.checks.find(t.job.id)).toMatchObject({
      state: "active",
      checkState: "dropped",
      lastCode: "CHECK_RUN_PERMISSION_MISSING",
      reviewId: "5001",
    });
  });

  it("is not made pending again by a success after the retries began", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);
    await t.checks.failed(t.job.id, {
      code: "INTEGRATION_ACCESS_UNAVAILABLE",
      retryAt: t.now(),
      maxAttempts: 5,
    });

    await t.checks.finish(t.job.id, { settled: false });

    expect(await t.checks.find(t.job.id)).toMatchObject({
      state: "active",
      attempts: 0,
    });
  });
});

describe("what the app asked of a pull request (review round 2)", () => {
  async function submit(
    t: Awaited<ReturnType<typeof setup>>,
    jobId: string,
    event: "approve" | "request_changes" | "withdrawn",
  ) {
    await t.checks.take(jobId, LEASE);
    await t.checks.recordReview(jobId, {
      reviewId: "5001",
      reviewState: "done",
      reviewEvent: event,
    });
    t.advance(SECOND);
  }

  // #405-T22
  it("keeps the event of a review next to its id", async () => {
    const t = await setup();

    await submit(t, t.job.id, "request_changes");

    expect(await t.checks.find(t.job.id)).toMatchObject({
      reviewId: "5001",
      reviewEvent: "request_changes",
    });
  });

  // #405-T22
  it("says nothing was asked when no review of the pull request recorded an event", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);
    // A skipped verdict records a state and no event.
    await t.checks.recordReview(t.job.id, {
      reviewId: null,
      reviewState: "done",
    });

    expect(await t.checks.lastReviewEventOfPullRequest(t.job.id)).toBeNull();
  });

  // #405-T22
  it("answers with the latest event of the pull request, whatever job it was recorded for", async () => {
    const t = await setup();
    await submit(t, t.job.id, "request_changes");
    const second = await t.enqueueNew({ headSha: sha("b") });
    await t.checks.take(second.id, LEASE);
    // The second job skipped its verdict: the request of the first still stands.
    await t.checks.recordReview(second.id, {
      reviewId: null,
      reviewState: "done",
    });

    expect(await t.checks.lastReviewEventOfPullRequest(second.id)).toBe(
      "request_changes",
    );

    const third = await t.enqueueNew({ headSha: sha("c") });
    await submit(t, third.id, "withdrawn");
    expect(await t.checks.lastReviewEventOfPullRequest(third.id)).toBe(
      "withdrawn",
    );
    const fourth = await t.enqueueNew({ headSha: sha("d") });
    await submit(t, fourth.id, "approve");
    expect(await t.checks.lastReviewEventOfPullRequest(fourth.id)).toBe(
      "approve",
    );
  });

  // #405-T22
  it("does not mix up two pull requests", async () => {
    const t = await setup();
    await submit(t, t.job.id, "request_changes");
    const other = await t.enqueueNew({
      prNumber: 8,
      prUrl: "https://github.test/acme/widgets/pull/8",
    });
    await t.checks.take(other.id, LEASE);

    expect(await t.checks.lastReviewEventOfPullRequest(other.id)).toBeNull();
  });
});

describe("finding the jobs whose check run is behind", () => {
  // #405-T32 (review P1-1, P3-1)
  it("reaches a retry that is due even when many newer jobs without a row are waiting", async () => {
    const t = await setup();
    await t.queue.claimNext("runner-1");
    await t.checks.take(t.job.id, LEASE);
    await t.checks.recordCheck(t.job.id, {
      checkRunId: "9001",
      syncedStatus: "queued",
    });
    await t.checks.failed(t.job.id, {
      code: "INTEGRATION_ACCESS_UNAVAILABLE",
      retryAt: new Date(t.now().getTime() + 5 * MINUTE),
      maxAttempts: 30,
    });
    for (let n = 0; n < 25; n += 1) {
      t.advance(SECOND);
      await t.enqueueNew({
        prNumber: 100 + n,
        prUrl: `https://github.test/acme/widgets/pull/${String(100 + n)}`,
      });
    }
    t.advance(2 * 60 * MINUTE);

    const listed = await listJobsWithCheckWork(t.db, t.now(), { limit: 20 });

    expect(listed).toHaveLength(20);
    expect(listed[0]?.jobId).toBe(t.job.id);
  });

  // #405-T06
  it("lists a running job without a row, and a job whose check run shows an older status", async () => {
    const t = await setup();
    const claimed = await t.queue.claimNext("runner-1");
    expect(claimed?.job.id).toBe(t.job.id);
    const behind = await t.enqueueNew({
      prNumber: 8,
      prUrl: "https://github.test/acme/widgets/pull/8",
    });
    await t.checks.take(behind.id, LEASE);
    await t.checks.recordCheck(behind.id, {
      checkRunId: "9002",
      syncedStatus: "queued",
    });
    await t.checks.finish(behind.id, { settled: false });

    const listed = await listJobsWithCheckWork(t.db, t.now(), { limit: 10 });

    expect(listed.map((item) => item.jobId).sort()).toEqual([t.job.id].sort());
  });

  // #405-T06
  it("lists a job that ended after its check run showed it running", async () => {
    const t = await setup();
    const claimed = await t.queue.claimNext("runner-1");
    await t.checks.take(t.job.id, LEASE);
    await t.checks.recordCheck(t.job.id, {
      checkRunId: "9001",
      syncedStatus: "running",
    });
    await t.checks.finish(t.job.id, { settled: false });
    t.advance(30 * MINUTE);
    await t.queue.expireStaleJobs();
    expect(claimed).not.toBeNull();

    const listed = await listJobsWithCheckWork(t.db, t.now(), { limit: 10 });

    expect(listed).toEqual([{ jobId: t.job.id, workspaceId: t.workspaceId }]);
  });

  // #405-T12
  it("does not list a job for its check run once that was dropped, only for a verdict that is still due", async () => {
    const t = await setup();
    await t.checks.take(t.job.id, LEASE);
    await t.checks.dropCheck(t.job.id, "CHECK_RUN_PERMISSION_MISSING");
    await t.checks.finish(t.job.id, { settled: false });
    await t.queue.claimNext("runner-1");

    expect(await listJobsWithCheckWork(t.db, t.now(), { limit: 10 })).toEqual(
      [],
    );
    const token = await t.tokenOf(t.job.id);
    await t.queue.complete(t.job.id, token, { ok: true, result: { ok: true } });
    expect(await listJobsWithCheckWork(t.db, t.now(), { limit: 10 })).toEqual([
      { jobId: t.job.id, workspaceId: t.workspaceId },
    ]);
  });

  // #405-T17
  it("does not list a row that is in step, one that is leased, one that waits for its back-off, or one that is settled or dropped", async () => {
    const t = await setup();
    const inStep = t.job;
    await t.checks.take(inStep.id, LEASE);
    await t.checks.recordCheck(inStep.id, {
      checkRunId: "9001",
      syncedStatus: "queued",
    });
    await t.checks.finish(inStep.id, { settled: false });

    expect(await listJobsWithCheckWork(t.db, t.now(), { limit: 10 })).toEqual(
      [],
    );
    await t.queue.claimNext("runner-1");
    // Behind now (running, but the check run shows queued), and leased by a sync that is in flight.
    await t.checks.take(inStep.id, LEASE);
    expect(await listJobsWithCheckWork(t.db, t.now(), { limit: 10 })).toEqual(
      [],
    );
    await t.checks.failed(inStep.id, {
      code: "INTEGRATION_ACCESS_UNAVAILABLE",
      retryAt: new Date(t.now().getTime() + 5 * MINUTE),
      maxAttempts: 5,
    });
    expect(await listJobsWithCheckWork(t.db, t.now(), { limit: 10 })).toEqual(
      [],
    );
    t.advance(5 * MINUTE);
    expect(await listJobsWithCheckWork(t.db, t.now(), { limit: 10 })).toEqual([
      { jobId: inStep.id, workspaceId: t.workspaceId },
    ]);
    await t.checks.take(inStep.id, LEASE);
    await t.checks.drop(inStep.id, "CHECK_RUN_PERMISSION_MISSING");
    t.advance(60 * MINUTE);
    expect(await listJobsWithCheckWork(t.db, t.now(), { limit: 10 })).toEqual(
      [],
    );
  });

  it("lists a succeeded job whose verdict is still pending, and no job that finished long before there was a row", async () => {
    const t = await setup();
    await t.queue.claimNext("runner-1");
    const token = await t.tokenOf(t.job.id);
    await t.queue.complete(t.job.id, token, {
      ok: true,
      result: { ok: true },
    });
    await t.checks.take(t.job.id, LEASE);
    await t.checks.recordCheck(t.job.id, {
      checkRunId: "9001",
      syncedStatus: "succeeded",
    });
    await t.checks.finish(t.job.id, { settled: false });

    expect(
      (await listJobsWithCheckWork(t.db, t.now(), { limit: 10 })).map(
        (item) => item.jobId,
      ),
    ).toEqual([t.job.id]);

    await t.checks.take(t.job.id, LEASE);
    await t.checks.recordReview(t.job.id, {
      reviewId: null,
      reviewState: "done",
    });
    await t.checks.finish(t.job.id, { settled: true });
    expect(await listJobsWithCheckWork(t.db, t.now(), { limit: 10 })).toEqual(
      [],
    );
  });
});
