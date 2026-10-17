// SPDX-License-Identifier: Apache-2.0

// The check run and the review verdict of review jobs (#405) end to end below the HTTP routes: a real database with
// the job queue, the real GitHub App provider and client over HTTP against the fake GitHub, and the service the
// running server uses. The fake GitHub shows what a pull request would show: the check runs of the commit with every
// state they were in, and the reviews with the decision GitHub would count.
import { describe, expect, it } from "vitest";
import {
  COMMENT_URL,
  HEAD,
  createCheckRunsHarness,
} from "../test-support/check-runs-harness.ts";
import { sha } from "../test-support/jobs.ts";
import { verdictMarker } from "./verdict.ts";

const BOT = "code-reviewer-test[bot]";
const MINUTE = 60 * 1000;
const NO_BLOCKER = {
  open: 1,
  bySeverity: { P0: 0, P1: 0, P2: 1, P3: 0 },
};
const BLOCKER = {
  open: 2,
  bySeverity: { P0: 1, P1: 0, P2: 1, P3: 0 },
};
const CLEAN = {
  open: 0,
  bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 },
};

describe("the check run of a job through its states", () => {
  // #405-T01
  it("is queued with the title waiting once the job is enqueued, and its id is kept", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toMatchObject([
      {
        name: "Code Reviewer",
        headSha: HEAD,
        status: "queued",
        conclusion: null,
        externalId: job.id,
        output: { title: "Waiting" },
      },
    ]);
    expect(await t.rowOf(job.id)).toMatchObject({
      checkRunId: String(t.checkRuns()[0]?.id),
      syncedStatus: "queued",
      state: "active",
    });
  });

  // #405-T02
  it("is in progress with the title reviewing once a worker claimed the job, on the same check run", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    await t.claim();

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({
      status: "in_progress",
      output: { title: "Reviewing" },
    });
    expect(t.checkRuns()[0]?.history.map((state) => state.status)).toEqual([
      "queued",
      "in_progress",
    ]);
  });

  // #405-T03
  it("completes with success, the open findings per severity and a link to the review comment", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
      detailsUrl: COMMENT_URL,
      output: { title: "Review finished" },
    });
    expect(t.checkRuns()[0]?.output?.summary).toContain(
      "2 open findings: P0 1 · P1 0 · P2 1 · P3 0",
    );
    expect(t.checkRuns()[0]?.output?.summary).toContain(COMMENT_URL);
  });

  // #405-T05
  it("completes neutral with a readable reason for a failure, never red", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    const claimed = await t.claim();
    await t.fail(claimed.job, claimed.token, "llm_auth");

    await t.service.syncJob(job.id);

    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Review did not finish" },
    });
    expect(t.checkRuns()[0]?.output?.summary).toContain(
      "The AI provider refused the API key.",
    );
    expect(t.checkRuns()[0]?.history.map((state) => state.conclusion)).toEqual([
      null,
      "neutral",
    ]);
  });

  // #405-T07
  it("goes back to queued when the job is given back, and the next claim uses the same check run", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const first = await t.claim();
    await t.service.syncJob(job.id);
    await t.fixture.queue.release(job.id, first.token, "launch_failed");
    await t.service.syncJob(job.id);
    expect(t.checkRuns()[0]).toMatchObject({ status: "queued" });

    t.fixture.clock.advance(MINUTE);
    await t.claim();
    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]?.history.map((state) => state.status)).toEqual([
      "in_progress",
      "queued",
      "in_progress",
    ]);
  });

  // #405-T27
  it("treats a review somebody asked for like an automatic one", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew({
      triggerKind: "manual",
      actorLogin: "alice",
    });
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });

    await t.service.syncJob(job.id);

    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "success" });
    expect(t.reviews()).toMatchObject([{ state: "APPROVED" }]);
  });
});

describe("a job that ends without a request of its own", () => {
  // #405-T06
  it("gets its check run completed by the reconciler when its lease ran out on the last attempt", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await t.claim();
      await t.service.syncJob(job.id);
      expect(t.checkRuns()[0]).toMatchObject({ status: "in_progress" });
      // No heartbeat: the lease runs out, and the next claim (or the sweep) deals with it.
      t.fixture.clock.advance(5 * MINUTE);
      await t.fixture.queue.expireStaleJobs();
    }

    const report = await t.service.reconcileDue();

    expect(report.synced).toBe(1);
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
    });
    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
    });
    expect(t.checkRuns()[0]?.output?.summary).toContain("`lease_expired`");
    expect(await t.rowOf(job.id)).toMatchObject({ state: "settled" });
  });

  // #405-T06
  it("gets its check run completed when it ran past the hard time limit", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.service.syncJob(job.id);
    // The runner keeps its lease alive but the job outlives the hard limit.
    for (let minute = 0; minute < 30; minute += 1) {
      t.fixture.clock.advance(MINUTE);
      await t.fixture.queue.heartbeat(job.id, claimed.token);
    }
    await t.fixture.queue.expireStaleJobs();

    await t.service.reconcileDue();

    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
    });
    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
    });
  });

  // #405-T06
  it("brings the check run of a job that went back to the queue back to waiting", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.claim();
    await t.service.syncJob(job.id);
    t.fixture.clock.advance(5 * MINUTE);
    await t.fixture.queue.expireStaleJobs();

    await t.service.reconcileDue();

    expect(t.checkRuns()[0]).toMatchObject({ status: "queued" });
  });

  // #405-T10
  it("completes the check run of a waiting job that was dropped because the pull request was closed", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    await t.fixture.queue.discardWaitingForPr(t.fixture.repositoryId, 7);

    await t.service.reconcileDue();

    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Review cancelled" },
    });
    expect(t.checkRuns()[0]?.output?.summary).toContain(
      "The pull request was closed",
    );
  });

  // #405-T10
  it("completes the check run of a waiting job whose project was switched off", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    await t.fixture.queue.cancelWaitingForRepository(t.fixture.repositoryId);

    await t.service.reconcileDue();

    expect(t.checkRuns()[0]?.output?.summary).toContain(
      "The project was switched off",
    );
  });
});

describe("a job that a newer push replaced", () => {
  // #405-T08
  it("completes the check run of a waiting job as superseded, and the newer job has its own on the new commit", async () => {
    const t = await createCheckRunsHarness();
    const first = await t.fixture.enqueueNew();
    await t.service.syncJob(first.id);
    const second = await t.fixture.enqueueNew({ headSha: sha("b") });

    await t.service.syncJob(first.id);
    await t.service.syncJob(second.id);

    expect(t.checkRuns()).toMatchObject([
      {
        headSha: HEAD,
        status: "completed",
        conclusion: "neutral",
        output: { title: "Superseded by a newer commit" },
      },
      { headSha: sha("b"), status: "queued", externalId: second.id },
    ]);
  });

  // #405-T09
  it("completes the check run of a running job as superseded and submits no review", async () => {
    const t = await createCheckRunsHarness();
    const first = await t.fixture.enqueueNew();
    const claimed = await t.claim({ acceptsSupersede: true });
    await t.service.syncJob(first.id);
    await t.fixture.enqueueNew({ headSha: sha("b") });
    // The superseded run reports what it used; its result is stored once and the job stays superseded.
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });

    await t.service.syncJob(first.id);

    expect(await t.fixture.queue.get(first.id)).toMatchObject({
      status: "superseded",
    });
    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Superseded by a newer commit" },
    });
    expect(t.reviews()).toEqual([]);
  });

  // #405-T11
  it("creates no check run for a job that was replaced before any was shown", async () => {
    const t = await createCheckRunsHarness();
    const first = await t.fixture.enqueueNew();
    await t.fixture.enqueueNew({ headSha: sha("b") });

    await t.service.syncJob(first.id);

    expect(t.checkRuns()).toEqual([]);
    expect(await t.rowOf(first.id)).toMatchObject({ state: "settled" });
  });

  // #405-T11
  it("creates no check run for a job that was cancelled before any was shown", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.fixture.queue.discardWaitingForPr(t.fixture.repositoryId, 7);

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toEqual([]);
  });

  // #405-T05
  it("does show a job that failed before any check run was made", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.fail(claimed.job, claimed.token, "timeout");

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "neutral" });
  });
});

describe("repeating and overlapping syncs", () => {
  // #405-T17
  it("makes no call to GitHub when there is nothing new", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    const before = t.fake.requests().length;

    await t.service.syncJob(job.id);
    await t.service.syncJob(job.id);

    expect(t.fake.requests()).toHaveLength(before);
  });

  // #405-T16
  it("makes one check run when two syncs of a job run at the same time", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();

    await Promise.all([
      t.service.syncJob(job.id),
      t.service.syncJob(job.id),
      t.service.syncJob(job.id),
    ]);

    expect(t.checkRuns()).toHaveLength(1);
  });

  // #405-T16
  it("finds the check run an earlier attempt made but did not keep, and changes that one", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const { integration, repo } = await t.target();
    // The earlier attempt: the check run exists on GitHub, and the app only knows it started to make one.
    await t.provider.publishReviewCheck?.(
      integration,
      repo,
      {
        jobId: job.id,
        headSha: HEAD,
        name: "Code Reviewer",
        status: "queued",
        title: "Waiting",
        summary: "x",
      },
      { checkRunId: null, mayExist: false },
    );
    const checks = t.fixture.db;
    await checks
      .insertInto("job_check_runs")
      .values({
        job_id: job.id,
        workspace_id: t.fixture.workspaceId,
        check_create_attempts: 1,
        next_attempt_at: t.fixture.clock.now().toISOString(),
        created_at: t.fixture.clock.now().toISOString(),
        updated_at: t.fixture.clock.now().toISOString(),
      })
      .execute();
    await t.claim();

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({ status: "in_progress" });
    expect(await t.rowOf(job.id)).toMatchObject({
      checkRunId: String(t.checkRuns()[0]?.id),
    });
  });

  it("goes round again when the job moved on while it was syncing", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    let claimed = false;
    // The job is claimed while the check run is being made.
    const original = t.fixture.queue.get;
    let reads = 0;
    t.fixture.queue.get = async (id) => {
      const result = await original(id);
      reads += 1;
      if (reads === 1 && !claimed) {
        claimed = true;
        await t.claim();
      }
      return result;
    };

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({ status: "in_progress" });
  });
});

describe("an App that may not write check runs", () => {
  const WITHOUT_CHECKS = {
    metadata: "read",
    contents: "read",
    pull_requests: "write",
    issues: "write",
  } as const;

  // #405-T12
  it("leaves the job alone and has no check run: one stable log code, no retries", async () => {
    const t = await createCheckRunsHarness({ permissions: WITHOUT_CHECKS });
    const job = await t.fixture.enqueueNew();

    await t.service.syncJob(job.id);
    const claimed = await t.claim();
    await t.service.syncJob(job.id);
    await t.fail(claimed.job, claimed.token, "timeout");
    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toEqual([]);
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
    });
    expect(await t.rowOf(job.id)).toMatchObject({
      checkState: "dropped",
      lastCode: "CHECK_RUN_PERMISSION_MISSING",
      state: "settled",
    });
    expect(
      t.lines.error.filter((line) =>
        line.includes("CHECK_RUN_PERMISSION_MISSING"),
      ),
    ).toHaveLength(1);
    expect(t.lines.error.join("\n")).toContain(`job=${job.id}`);
  });

  // #405-T12
  it("still submits the verdict, which needs another permission", async () => {
    const t = await createCheckRunsHarness({ permissions: WITHOUT_CHECKS });
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toEqual([]);
    expect(t.reviews()).toMatchObject([{ state: "CHANGES_REQUESTED" }]);
  });

  // #405-T12
  it("starts to show check runs for the jobs after the permission was accepted", async () => {
    const t = await createCheckRunsHarness({ permissions: WITHOUT_CHECKS });
    const first = await t.fixture.enqueueNew();
    await t.service.syncJob(first.id);
    t.fake.setAppPermissions({ ...WITHOUT_CHECKS, checks: "write" });

    const second = await t.fixture.enqueueNew({
      prNumber: 8,
      prUrl: "https://github.test/acme/widgets/pull/8",
    });
    await t.service.syncJob(second.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({ externalId: second.id });
  });
});

describe("GitHub failing", () => {
  // #405-T15
  it("leaves the job alone, waits and tries again, and shows the check run once GitHub is back", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.fail({ pathIncludes: "/check-runs", status: 502 });

    await t.service.syncJob(job.id);

    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "queued",
    });
    expect(await t.rowOf(job.id)).toMatchObject({
      state: "active",
      attempts: 1,
      lastCode: "INTEGRATION_ACCESS_UNAVAILABLE",
    });
    expect(t.lines.error.join("\n")).toContain(
      "CHECK_RUN_FAILED job=" + job.id,
    );
    // Its back-off has not passed: the reconciler leaves it alone.
    expect((await t.service.reconcileDue()).synced).toBe(0);

    t.fake.clearFailures();
    t.fixture.clock.advance(3 * MINUTE);
    expect((await t.service.reconcileDue()).synced).toBe(1);
    expect(t.checkRuns()).toHaveLength(1);
    expect(await t.rowOf(job.id)).toMatchObject({ attempts: 0 });
  });

  // #405-T15
  it("gives a job up after its attempts are used up", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.fail({ pathIncludes: "/check-runs", status: 502 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      t.fixture.clock.advance(20 * MINUTE);
      await t.service.syncJob(job.id);
    }

    expect(await t.rowOf(job.id)).toMatchObject({
      state: "dropped",
      attempts: 5,
    });
    t.fake.clearFailures();
    t.fixture.clock.advance(60 * MINUTE);
    expect((await t.service.reconcileDue()).synced).toBe(0);
    expect(t.checkRuns()).toEqual([]);
  });

  // #405-T15
  it("waits for a rate limit as long as GitHub says", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.fail({
      pathIncludes: "/check-runs",
      status: 429,
      headers: { "retry-after": "1800" },
    });

    await t.service.syncJob(job.id);

    const row = await t.rowOf(job.id);
    expect(row?.lastCode).toBe("INTEGRATION_ACCESS_RATE_LIMITED");
    expect(Date.parse(row?.nextAttemptAt ?? "")).toBeGreaterThanOrEqual(
      t.fixture.clock.now().getTime() + 1800 * 1000,
    );
  });

  it("gives up for good on an installation that is gone", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.removeInstallation(4242);

    await t.service.syncJob(job.id);

    expect(await t.rowOf(job.id)).toMatchObject({
      state: "dropped",
      lastCode: "INTEGRATION_ACCESS_CONNECTION_GONE",
    });
  });
});

describe("the verdict of a successful review", () => {
  // #405-T20
  it("requests changes on the reviewed commit for a blocking finding, with a short body and a link", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });

    await t.service.syncJob(job.id);

    const [review, ...others] = t.reviews();
    expect(others).toEqual([]);
    expect(review).toMatchObject({
      login: BOT,
      state: "CHANGES_REQUESTED",
      commitId: HEAD,
    });
    expect(review?.body).toContain("changes requested");
    expect(review?.body).toContain(COMMENT_URL);
    expect(review?.body).toContain(verdictMarker(job.id));
    expect(review?.body.length).toBeLessThan(400);
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewId: String(review?.id),
      reviewState: "done",
      state: "settled",
    });
  });

  // #405-T21
  it("approves a review with no blocking finding", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: NO_BLOCKER });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toMatchObject([{ state: "APPROVED", login: BOT }]);
  });

  // #405-T22
  it("replaces its own earlier verdict on a new push, and never touches a human review", async () => {
    const t = await createCheckRunsHarness();
    const first = await t.fixture.enqueueNew();
    const firstClaim = await t.claim();
    await t.succeed(firstClaim.job, firstClaim.token, { findings: BLOCKER });
    await t.service.syncJob(first.id);
    t.fake.addPullRequestReview(t.repo, 7, {
      login: "carol",
      event: "REQUEST_CHANGES",
      body: "Please add a test",
    });
    expect(t.fake.pullRequestReviewDecisions(t.repo, 7)).toEqual({
      [BOT]: "CHANGES_REQUESTED",
      carol: "CHANGES_REQUESTED",
    });
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("b") });
    const second = await t.fixture.enqueueNew({ headSha: sha("b") });
    const secondClaim = await t.claim();
    await t.succeed(secondClaim.job, secondClaim.token, { findings: CLEAN });

    await t.service.syncJob(second.id);

    expect(t.fake.pullRequestReviewDecisions(t.repo, 7)).toEqual({
      [BOT]: "APPROVED",
      carol: "CHANGES_REQUESTED",
    });
    expect(t.reviews().map((review) => review.state)).toEqual([
      "CHANGES_REQUESTED",
      "CHANGES_REQUESTED",
      "APPROVED",
    ]);
    // Nothing was dismissed or edited: the earlier reviews are as they were.
    expect(t.reviews()[2]?.commitId).toBe(sha("b"));
  });

  // #405-T23
  it("submits nothing for a failed job", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.fail(claimed.job, claimed.token, "llm_timeout");

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
  });

  // #405-T23
  it("submits nothing for a cancelled job", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    await t.fixture.queue.discardWaitingForPr(t.fixture.repositoryId, 7);

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
  });

  // #405-T24
  it("submits nothing when the pull request moved to a newer head, and says why", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("b") });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=stale_head");
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewState: "done",
      reviewId: null,
    });
    // The check run still says the review finished.
    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "success" });
  });

  // #405-T24
  it("submits nothing on a pull request that is closed", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    t.fake.updatePullRequest(t.repo, 7, { state: "closed" });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=pull_request_closed");
  });

  // #405-T25
  it("does not submit a second review when the first one was submitted and its id was not kept", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    const { integration, repo } = await t.target();
    const earlier = await t.provider.submitReviewVerdict?.(
      integration,
      repo,
      7,
      {
        jobId: job.id,
        headSha: HEAD,
        event: "approve",
        body: `fine\n${verdictMarker(job.id)}`,
        marker: verdictMarker(job.id),
      },
      { lookForEarlier: false },
    );
    // The app only knows it started to submit one.
    const now = t.fixture.clock.now().toISOString();
    await t.fixture.db
      .insertInto("job_check_runs")
      .values({
        job_id: job.id,
        workspace_id: t.fixture.workspaceId,
        review_submit_attempts: 1,
        next_attempt_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await t.service.syncJob(job.id);

    expect(t.reviews()).toHaveLength(1);
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewId: earlier?.reviewId,
      reviewState: "done",
    });
  });

  // #405-T26
  it("leaves the check run alone and gives the verdict up when GitHub refuses it for good", async () => {
    const t = await createCheckRunsHarness();
    t.fake.addPullRequest(t.repo, {
      number: 7,
      title: "Written by the app",
      state: "open",
      headSha: HEAD,
      headRef: "bot/change",
      baseRef: "main",
      author: { login: BOT, id: 1 },
    });
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "success" });
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewState: "dropped",
      state: "settled",
    });
    expect(t.lines.error.join("\n")).toContain("REVIEW_VERDICT_REFUSED");
  });

  // #405-T26
  it("treats a forbidden review like a refused one, and retries a failing GitHub", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    t.fake.fail({ pathIncludes: "/pulls/7/reviews", status: 502, times: 1 });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewState: "pending",
      attempts: 1,
    });
    t.fixture.clock.advance(3 * MINUTE);
    await t.service.reconcileDue();
    expect(t.reviews()).toMatchObject([{ state: "APPROVED" }]);
  });
});

describe("the verdict setting", () => {
  // #405-T18
  it("off submits no review and the check run still shows the result", async () => {
    const t = await createCheckRunsHarness();
    t.setVerdictMode("off");
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "success" });
    expect(t.lines.info.join("\n")).toContain("reason=off");
  });

  // #405-T18
  it("blocking approves a review with only low priority findings", async () => {
    const t = await createCheckRunsHarness();
    t.setVerdictMode("blocking");
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: NO_BLOCKER });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toMatchObject([{ state: "APPROVED" }]);
  });

  // #405-T18
  it("any requests changes for a finding of the lowest priority", async () => {
    const t = await createCheckRunsHarness();
    t.setVerdictMode("any");
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: { open: 1, bySeverity: { P0: 0, P1: 0, P2: 0, P3: 1 } },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toMatchObject([{ state: "CHANGES_REQUESTED" }]);
  });

  // #405-T19
  it("blocking submits nothing for a Diff review, whose findings have no severity", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: { open: 3, bySeverity: null },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=no_severity");
    expect(t.checkRuns()[0]?.output?.summary).toContain("3 open findings.");
  });

  // #405-T19
  it("any requests changes for the active findings of a Diff review and approves when none is active", async () => {
    const t = await createCheckRunsHarness();
    t.setVerdictMode("any");
    const first = await t.fixture.enqueueNew();
    const firstClaim = await t.claim();
    await t.succeed(firstClaim.job, firstClaim.token, {
      findings: { open: 2, bySeverity: null },
    });
    await t.service.syncJob(first.id);
    const second = await t.fixture.enqueueNew({
      prNumber: 8,
      prUrl: "https://github.test/acme/widgets/pull/8",
    });
    t.fake.addPullRequest(t.repo, {
      number: 8,
      title: "Another",
      state: "open",
      headSha: HEAD,
      headRef: "feature/other",
      baseRef: "main",
      author: { login: "bob", id: 1002 },
    });
    const secondClaim = await t.claim();
    await t.succeed(secondClaim.job, secondClaim.token, {
      findings: { open: 0, bySeverity: null },
    });
    await t.service.syncJob(second.id);

    expect(t.reviews()).toMatchObject([{ state: "CHANGES_REQUESTED" }]);
    expect(t.fake.pullRequestReviews(t.repo, 8)).toMatchObject([
      { state: "APPROVED" },
    ]);
  });

  // #405-T19
  it("submits nothing for a result that does not say what is open", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token);

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=findings_unknown");
  });

  // #405-T19
  it("does not approve a review that stopped at its cost limit", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: CLEAN,
      usage: { stoppedEarly: "cost_limit" },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=review_incomplete");
    expect(t.checkRuns()[0]?.output?.summary).toContain("cost limit");
  });
});

describe("a verdict from a review that proves nothing", () => {
  // #405-T19 (review P1-3)
  it("does not approve a review that dropped findings or left files out, and says so in the check", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: { ...CLEAN, incomplete: true },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=review_incomplete");
  });

  // #405-T19 (review P1-3)
  it("still requests changes for a blocker of a review that is incomplete", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: { ...BLOCKER, incomplete: true },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toMatchObject([{ state: "CHANGES_REQUESTED" }]);
  });

  // #405-T19 (review P2-3)
  it("does not approve a result that made no model call", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: CLEAN,
      usage: { aiCalls: 0 },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=no_model_work");
  });
});

describe("what the tokens and the logs hold", () => {
  // #405-T34
  it("asks for a token limited to one repository and the least permissions for each call, and logs no token", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });
    await t.service.syncJob(job.id);

    const scoped = t.fake
      .tokenRequests()
      .filter((request) => request.permissions !== null);
    expect(scoped.length).toBeGreaterThanOrEqual(3);
    for (const request of scoped) {
      expect(request.repositoryIds).toEqual([t.repoId]);
      expect(Object.keys(request.permissions ?? {}).sort()).toSatisfy(
        (keys: string[]) =>
          JSON.stringify(keys) === JSON.stringify(["checks", "metadata"]) ||
          JSON.stringify(keys) ===
            JSON.stringify(["metadata", "pull_requests"]),
      );
    }
    const logged = [...t.lines.info, ...t.lines.error].join("\n");
    for (const credential of t.fake.seenCredentials())
      expect(logged).not.toContain(credential);
  });
});
