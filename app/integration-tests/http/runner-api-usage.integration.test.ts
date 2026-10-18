// SPDX-License-Identifier: Apache-2.0

// The usage record of a job from the claim to the end (src/usage/README.md), through the real runner API over
// a real SQLite file: the claim reserves it in its own transaction, the completion settles it from the result,
// and a job that ends without a model call voids it. The record is a bookkeeping side effect: what a runner
// is handed and what a job does are pinned by the other runner API tests.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import { sha } from "../../src/test-support/jobs.ts";
import {
  goodResult,
  startRunnerApiHarness,
  TEST_LLM_API_KEY,
  TEST_LLM_MODEL,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const MINUTE = 60 * 1000;
const ENGINES = ["opencode"];

const recordsOf = (h: RunnerApiHarness) =>
  createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now);

async function allRecords(h: RunnerApiHarness) {
  return h.db.selectFrom("usage_records").selectAll().orderBy("id").execute();
}

/** A job claimed through the API: its id and the lease token of the claim. */
async function claimedJob(
  h: RunnerApiHarness,
  options: { runnerId?: string; prNumber?: number } = {},
) {
  const job = await h.enqueueNew(
    options.prNumber === undefined ? {} : { prNumber: options.prNumber },
  );
  const body = await h.claimed({ runnerId: options.runnerId ?? "runner-a" });
  return { id: job.id, leaseToken: body.job.leaseToken };
}

/** A harness whose first repository runs Dynamic Review. */
async function startDynamic() {
  const h = await startRunnerApiHarness({ projects: true });
  await h.projectService.activateProject(h.repositoryId);
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    reviewKind: "dynamic",
    dynamicModel: "vendor/dynamic-model",
  });
  return h;
}

describe("the claim of a job", () => {
  // #272-T01
  it("reserves one record with the kind of the job and the key it runs on", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    expect(await allRecords(h)).toEqual([
      expect.objectContaining({
        workspace_id: h.workspaceId,
        job_id: job.id,
        review_kind: "diff",
        key_mode: "own",
        model_tier: null,
        state: "reserved",
        reserved_at: h.clock.now().toISOString(),
        settled_at: null,
      }),
    ]);
  });

  // #272-T01
  it("records a Dynamic job as dynamic", async () => {
    const h = await startDynamic();
    const job = await h.enqueueNew();

    await h.claimed({ engines: ENGINES });

    expect(await recordsOf(h).get(job.id)).toMatchObject({
      reviewKind: "dynamic",
      state: "reserved",
    });
  });

  // #272-T01
  it("records the operator's key as managed", async () => {
    const h = await startRunnerApiHarness();
    await h.llm
      .operatorKey()
      .save(
        { provider: "openrouter", apiKey: "plain-operator-key-0001-aaaa" },
        null,
      );
    await createWorkspaceEntitlementsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).put(
      {
        planLabel: "plan",
        keyMode: "managed",
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
        periodStart: "2026-10-01T00:00:00.000Z",
        suspended: false,
        suspensionCode: null,
      },
      null,
    );
    const job = await claimedJob(h);

    expect(await recordsOf(h).get(job.id)).toMatchObject({
      keyMode: "managed",
      state: "reserved",
    });
  });

  // #272-T08
  it("runs a workspace without entitlements exactly as before and still records it", async () => {
    const h = await startRunnerApiHarness();
    expect(
      await h.db.selectFrom("workspace_entitlements").selectAll().execute(),
    ).toEqual([]);
    await h.enqueueNew();

    const body = await h.claimed();

    expect(body.job.input.llm).toStrictEqual({
      provider: "openrouter",
      model: TEST_LLM_MODEL,
      apiKey: TEST_LLM_API_KEY,
    });
    expect(await allRecords(h)).toHaveLength(1);
    const done = await h.complete(body.job.id, body.job.leaseToken);
    expect(done.status).toBe(200);
    expect(await recordsOf(h).get(body.job.id)).toMatchObject({
      state: "settled",
    });
  });

  // #272-T05
  it("reuses the record when the lease is lost and the job is claimed again", async () => {
    const h = await startRunnerApiHarness();
    const first = await claimedJob(h, { runnerId: "runner-a" });
    const reserved = await recordsOf(h).get(first.id);
    h.clock.advance(3 * MINUTE);

    const second = await h.claimed({ runnerId: "runner-b" });

    expect(second.job.id).toBe(first.id);
    expect(await allRecords(h)).toHaveLength(1);
    expect(await recordsOf(h).get(first.id)).toEqual(reserved);

    // The old holder can no longer settle it; the new one does.
    const late = await h.complete(
      first.id,
      first.leaseToken,
      {},
      { runnerId: "runner-a" },
    );
    expect(late.status).toBe(409);
    expect((await recordsOf(h).get(first.id))?.state).toBe("reserved");
    await h.complete(
      second.job.id,
      second.job.leaseToken,
      {},
      { runnerId: "runner-b" },
    );
    expect(await allRecords(h)).toHaveLength(1);
    expect((await recordsOf(h).get(first.id))?.state).toBe("settled");
  });
});

describe("the completion of a job", () => {
  // #272-T02
  it("settles the record with the cost in micro-USD, rounded half up, and the tokens", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    h.clock.advance(41 * 1000);

    await h.complete(job.id, job.leaseToken, {
      usage: {
        model: TEST_LLM_MODEL,
        promptTokens: 12000,
        completionTokens: 900,
        totalTokens: 12900,
        aiCalls: 2,
        fallbackUsed: false,
        stoppedEarly: null,
        costUsd: 0.0123456,
      },
    });

    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "settled",
      costMicroUsd: 12346,
      promptTokens: 12000,
      completionTokens: 900,
      settledAt: h.clock.now().toISOString(),
    });
  });

  // #272-T03
  it("settles, and does not void, a result whose cost is unknown", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {
      usage: { ...goodResult().usage!, costUsd: null },
    });

    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "settled",
      costMicroUsd: null,
      promptTokens: 12000,
    });
  });

  // #272-T04
  it("voids the record of a job that failed before any model call", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "checkout_failed",
      errorMessage: "could not read the repository",
      commentUrl: null,
      usage: null,
    });

    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "void",
      settledAt: null,
      costMicroUsd: null,
    });
  });

  // #273-T05
  it("settles the record of a failed result with the usage it reports", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    h.clock.advance(41 * 1000);

    const response = await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "dynamic_budget_exceeded",
      errorMessage: "the cost limit is used up",
      commentUrl: null,
      usage: {
        model: TEST_LLM_MODEL,
        promptTokens: 300,
        completionTokens: 30,
        totalTokens: 330,
        aiCalls: 3,
        fallbackUsed: false,
        stoppedEarly: null,
        costUsd: 0.0035,
      },
    });

    expect(response.status).toBe(200);
    expect(await h.queue.get(job.id)).toMatchObject({ status: "failed" });
    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "settled",
      settledReason: null,
      costMicroUsd: 3500,
      promptTokens: 300,
      completionTokens: 30,
      settledAt: h.clock.now().toISOString(),
    });
  });

  // #273-T05: an unknown cost of a failed run is unknown, never 0, and the run is still counted.
  it("settles the record of a failed result whose cost is unknown with a null cost and its tokens", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "dynamic_accounting_failed",
      errorMessage: "the provider did not report the cost of a call",
      commentUrl: null,
      usage: {
        model: TEST_LLM_MODEL,
        promptTokens: 200,
        completionTokens: 20,
        totalTokens: 220,
        aiCalls: 2,
        fallbackUsed: false,
        stoppedEarly: null,
        costUsd: null,
      },
    });

    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "settled",
      costMicroUsd: null,
      promptTokens: 200,
      completionTokens: 20,
    });
  });

  // #273-T06: the loop of the runner ended a job process that held the job (hard timeout, killed, no
  // result line): the model may have been used.
  it("settles the record with an unknown cost when the runner's loop reports a process that left no result", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "timeout",
      errorReason: "no_result_from_process",
      errorMessage:
        "the job did not finish within the time limit and was ended",
      commentUrl: null,
      usage: null,
    });

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
    });
    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "settled",
      settledReason: "no_result",
      costMicroUsd: null,
      promptTokens: null,
      settledAt: h.clock.now().toISOString(),
    });
  });

  // #363-T05: a Diff command failed while its model call was in flight. PR-Agent counted no call, so the
  // runner sends no usage at all (the key is absent) and says that the model may have been used.
  it("settles a failed Diff result with the reason and no usage as a run with an unknown cost", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "llm_timeout",
      errorReason: "no_result_from_process",
      errorMessage: "the model did not answer in time",
      commentUrl: null,
      usage: undefined, // left out of the JSON: the Diff runner sends no usage key
    });

    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "settled",
      settledReason: "no_result",
      costMicroUsd: null,
      promptTokens: null,
      completionTokens: null,
      settledAt: h.clock.now().toISOString(),
    });
  });

  // #363-T05: the runner's own result line always carries the key, as `"usage": null`.
  it("settles a failed Diff result with the reason and an explicit null usage as a run with an unknown cost", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "llm_timeout",
      errorReason: "no_result_from_process",
      errorMessage: "the model did not answer in time",
      commentUrl: null,
      usage: null,
    });

    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "settled",
      settledReason: "no_result",
      costMicroUsd: null,
      promptTokens: null,
      completionTokens: null,
      settledAt: h.clock.now().toISOString(),
    });
  });

  // #363-T03: a Diff command that failed before it sent a request has neither usage nor reason: void.
  it("still voids a failed Diff result without usage and without the reason", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "git_auth",
      errorMessage: "the pull request could not be read",
      commentUrl: null,
      usage: undefined,
    });

    expect((await recordsOf(h).get(job.id))?.state).toBe("void");
  });

  // #273-T08: a runner of an earlier release sends the same failure without the reason: as before.
  it("still voids a timeout without usage and without the reason", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "timeout",
      errorMessage: "the command did not finish in time",
      commentUrl: null,
      usage: null,
    });

    expect((await recordsOf(h).get(job.id))?.state).toBe("void");
  });

  // #272-T07
  it("does not change the record again when the same result is reported twice", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    await h.complete(job.id, job.leaseToken);
    const settled = await recordsOf(h).get(job.id);
    h.clock.advance(5 * MINUTE);

    const again = await h.complete(job.id, job.leaseToken);

    expect((await again.json()).alreadyCompleted).toBe(true);
    expect(await recordsOf(h).get(job.id)).toEqual(settled);
  });

  it("leaves the record settled when a different result is reported afterwards", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    await h.complete(job.id, job.leaseToken);
    const settled = await recordsOf(h).get(job.id);

    const conflict = await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "checkout_failed",
      errorMessage: "late",
      commentUrl: null,
      usage: null,
    });

    expect(conflict.status).toBe(409);
    expect(await recordsOf(h).get(job.id)).toEqual(settled);
  });

  it("settles nothing when the runner is shut down and gives the job back, which stays reserved", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);

    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "runner_shutdown",
      errorMessage: "stopping",
      commentUrl: null,
      usage: null,
    });

    expect((await h.queue.get(job.id))?.status).toBe("queued");
    expect((await recordsOf(h).get(job.id))?.state).toBe("reserved");
  });
});

describe("a job that ends without reporting", () => {
  // #273-T06
  it("settles the record with an unknown cost, and says why, when the last attempt loses its lease", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await h.db
      .updateTable("jobs")
      .set({ attempts: 2 })
      .where("id", "=", job.id)
      .execute();
    await h.claimed();
    h.clock.advance(3 * MINUTE);

    await h.queue.expireStaleJobs();

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
    });
    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "settled",
      settledReason: "no_result",
      costMicroUsd: null,
      promptTokens: null,
      completionTokens: null,
      settledAt: h.clock.now().toISOString(),
    });
  });

  // #273-T06: a lease that runs out on an earlier attempt is not the end of the job: the record
  // stays reserved and counts once.
  it("keeps the record reserved while the job is tried again after a lost lease", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await h.claimed();
    h.clock.advance(3 * MINUTE);

    await h.queue.expireStaleJobs();

    expect((await h.queue.get(job.id))?.status).toBe("queued");
    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "reserved",
      settledReason: null,
    });
  });

  // #272-T04
  it("voids the record when the runner API ends the job at claim time", async () => {
    const h = await startRunnerApiHarness({ llmKey: null });
    const job = await h.enqueueNew();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "void",
      keyMode: "own",
    });
  });

  // #272-T04
  it("voids the record of a job cancelled at claim time", async () => {
    const h = await startRunnerApiHarness({ projects: true });
    const job = await h.enqueueNew();

    await h.claim();

    expect((await h.queue.get(job.id))?.status).toBe("cancelled");
    expect((await recordsOf(h).get(job.id))?.state).toBe("void");
  });

  // #272-T04
  it("voids the record of a job that is given back on its last attempt", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await h.db
      .updateTable("jobs")
      .set({ attempts: 2 })
      .where("id", "=", job.id)
      .execute();
    const claimed = await h.claimed();

    await h.queue.release(job.id, claimed.job.leaseToken, "claim_failed");

    expect((await h.queue.get(job.id))?.status).toBe("failed");
    expect((await recordsOf(h).get(job.id))?.state).toBe("void");
  });

  // #273-T06
  it("settles the record with an unknown cost when the job runs past the hard limit", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    for (let minute = 0; minute < 40; minute += 1) {
      h.clock.advance(MINUTE);
      await h.heartbeat(job.id, job.leaseToken);
    }

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
    });
    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "settled",
      settledReason: "no_result",
      costMicroUsd: null,
    });
  });

  // #273-T06: a runner that is shut down on the last attempt may have used the model; it could not
  // say how much.
  it("settles the record with an unknown cost when a runner that is shut down gives the job back on its last attempt", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await h.db
      .updateTable("jobs")
      .set({ attempts: 2 })
      .where("id", "=", job.id)
      .execute();
    const claimed = await h.claimed();

    await h.complete(job.id, claimed.job.leaseToken, {
      ok: false,
      errorCode: "runner_shutdown",
      errorMessage: "stopping",
      commentUrl: null,
      usage: null,
    });

    expect((await h.queue.get(job.id))?.status).toBe("failed");
    expect(await recordsOf(h).get(job.id)).toMatchObject({
      state: "settled",
      settledReason: "no_result",
      costMicroUsd: null,
    });
  });

  // #272-T04
  it("voids the reserved record of a job that went back to the queue and was cancelled there, at once", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    h.clock.advance(3 * MINUTE);
    await h.queue.expireStaleJobs();
    expect((await h.queue.get(job.id))?.status).toBe("queued");
    expect((await recordsOf(h).get(job.id))?.state).toBe("reserved");

    await h.queue.cancelWaitingForRepository(h.repositoryId);

    // No expiry step in between: nothing waits for a runner to poll.
    expect((await h.queue.get(job.id))?.status).toBe("cancelled");
    expect((await recordsOf(h).get(job.id))?.state).toBe("void");
    expect(await recordsOf(h).countByKind("2000-01-01T00:00:00.000Z")).toEqual({
      diff: 0,
      dynamic: 0,
    });
  });

  // #272-T04
  it("voids the reserved record of a job that was dropped with its closed pull request, at once", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    h.clock.advance(3 * MINUTE);
    await h.queue.expireStaleJobs();

    await h.queue.discardWaitingForPr(h.repositoryId, 7);

    expect((await recordsOf(h).get(job.id))?.state).toBe("void");
  });

  // #272-T04
  it("voids the reserved record of a job that a newer automatic job replaced, at once", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimedJob(h);
    h.clock.advance(3 * MINUTE);
    await h.queue.expireStaleJobs();
    expect((await recordsOf(h).get(job.id))?.state).toBe("reserved");

    const newer = await h.enqueue({ headSha: sha("b") });

    expect(newer.status).toBe("created");
    expect((await h.queue.get(job.id))?.status).toBe("superseded");
    expect((await recordsOf(h).get(job.id))?.state).toBe("void");
  });

  // #272-T04
  it("voids the reserved record of a Dynamic job that went back to the queue and was cancelled when Dynamic Review was switched off, at once", async () => {
    const h = await startDynamic();
    const job = await h.enqueueNew();
    await h.claimed({ engines: ENGINES });
    h.clock.advance(3 * MINUTE);
    await h.queue.expireStaleJobs();
    expect((await h.queue.get(job.id))?.status).toBe("queued");
    expect((await recordsOf(h).get(job.id))?.state).toBe("reserved");

    await createInstanceSettingsRepository(h.db, h.clock.now).set(
      "dynamic_review",
      { enabled: false },
      null,
    );

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "dynamic_review_disabled",
    });
    expect((await recordsOf(h).get(job.id))?.state).toBe("void");
  });
});
