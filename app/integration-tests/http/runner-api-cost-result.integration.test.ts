// SPDX-License-Identifier: Apache-2.0

// What a Dynamic result without a known cost settles as (#553), through the real runner API over a real database.
//
// On the own key (the user pays the provider) a cost the runner could not read is `costUsd: null`: the run succeeded, its
// usage record settles with an unknown cost (the operator API's unknown-cost counts include it) and billing charges the
// minutes only (outcome.ts). On the managed key (we pay) a success with no cost is not trusted: it is stored as
// `dynamic_accounting_failed`, which is our fault and free. A run that failed keeps the runner's code either way.
import { describe, expect, it } from "vitest";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import { classifyOutcome } from "../../src/billing/outcome.ts";
import {
  goodResult,
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const ENGINES = { engines: ["opencode"] };
const NO_COST = { ...goodResult().usage!, costUsd: null };

async function start(keyMode: "own" | "managed"): Promise<RunnerApiHarness> {
  const h = await startRunnerApiHarness({ projects: true });
  if (keyMode === "managed") {
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
  }
  await h.projectService.activateProject(h.repositoryId);
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    reviewKind: "dynamic",
    // On the operator's key the entry decides the model, and a project may not name one.
    ...(keyMode === "own" ? { dynamicModel: "vendor/dynamic-model" } : {}),
  });
  return h;
}

async function claimedDynamic(h: RunnerApiHarness) {
  const job = await h.enqueueNew();
  const body = await h.claimed(ENGINES);
  return { id: job.id, leaseToken: body.job.leaseToken };
}

const recordOf = (h: RunnerApiHarness, jobId: string) =>
  createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now).get(jobId);

describe("a Dynamic result on the own key", () => {
  // #553-T08
  it("succeeds with an unknown cost: the record settles with a null cost and its tokens, never zero", async () => {
    const h = await start("own");
    const job = await claimedDynamic(h);

    const done = await h.complete(job.id, job.leaseToken, { usage: NO_COST });

    expect(done.status).toBe(200);
    expect(await h.queue.get(job.id)).toMatchObject({ status: "succeeded" });
    expect(await recordOf(h, job.id)).toMatchObject({
      keyMode: "own",
      state: "settled",
      costMicroUsd: null,
      promptTokens: 12000,
    });
  });

  // #553-T08
  it("is counted among the runs whose cost is unknown, which the operator watches", async () => {
    const h = await start("own");
    const job = await claimedDynamic(h);
    await h.complete(job.id, job.leaseToken, { usage: NO_COST });
    const known = await h.enqueueNew({ prNumber: 8 });
    const second = await h.claimed(ENGINES);
    await h.complete(known.id, second.job.leaseToken);

    const [group] = await createUsageRecordsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).summarize({
      from: "2026-01-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
    });

    expect(group).toMatchObject({
      keyMode: "own",
      reviewKind: "dynamic",
      settledCount: 2,
      unknownCostCount: 1,
    });
  });

  // #553-T08
  it("bills the minutes only: a success whose AI cost is unknown", () => {
    expect(
      classifyOutcome({
        status: "succeeded",
        errorCode: null,
        keyMode: "own",
        aiCostKnown: false,
      }),
    ).toBe("minutes_only");
  });
});

describe("a Dynamic result on the managed key", () => {
  // #553-T09
  it("is not settled as a success without a cost: the job ends dynamic_accounting_failed", async () => {
    const h = await start("managed");
    const job = await claimedDynamic(h);

    const done = await h.complete(job.id, job.leaseToken, { usage: NO_COST });

    expect(done.status).toBe(200);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_accounting_failed",
    });
    expect(await recordOf(h, job.id)).toMatchObject({
      keyMode: "managed",
      state: "settled",
      costMicroUsd: null,
    });
  });

  // #553-T09
  it("is the same for a success that reports no usage at all", async () => {
    const h = await start("managed");
    const job = await claimedDynamic(h);

    await h.complete(job.id, job.leaseToken, { usage: null });

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_accounting_failed",
    });
  });

  // #553-T09
  it("repeats to the same stored result when the runner sends it twice", async () => {
    const h = await start("managed");
    const job = await claimedDynamic(h);

    await h.complete(job.id, job.leaseToken, { usage: NO_COST });
    const again = await h.complete(job.id, job.leaseToken, { usage: NO_COST });

    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyCompleted: true });
  });

  // #553-T09
  it("settles a success with a known cost as before", async () => {
    const h = await start("managed");
    const job = await claimedDynamic(h);

    await h.complete(job.id, job.leaseToken);

    expect(await h.queue.get(job.id)).toMatchObject({ status: "succeeded" });
    expect(await recordOf(h, job.id)).toMatchObject({ costMicroUsd: 40000 });
  });

  // #553-T03
  it("keeps the code of a failure that did not account for its run, and bills it as ours", async () => {
    const h = await start("managed");
    const job = await claimedDynamic(h);

    await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "dynamic_accounting_failed",
      errorMessage: "the cost of a model call could not be read",
      commentUrl: null,
      usage: NO_COST,
    });

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_accounting_failed",
    });
    expect(
      classifyOutcome({
        status: "failed",
        errorCode: "dynamic_accounting_failed",
        keyMode: "managed",
        aiCostKnown: false,
      }),
    ).toBe("free");
  });
});
