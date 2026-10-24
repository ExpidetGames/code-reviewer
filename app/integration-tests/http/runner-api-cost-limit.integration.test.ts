// SPDX-License-Identifier: Apache-2.0

// The cost limit of a project at claim time (#666): the review settings resolve `maxCostCents` (the project's value over the
// workspace default over none), and the claim hands it to the runner as `llm.maxCostUsd`, on both ways a job reaches a runner
// (the legacy claim and the Worker API's first fetch) and for both kinds of review. A runner that did not say it enforces the
// limit (the claim feature `cost_limit`) never gets the field (the job is closed): it runs with the operator's limit alone and the
// log says so, since a refused review is worse than an unenforced limit while a release is rolling out. A job without a limit is
// the job of today, byte for byte.
import { describe, expect, it } from "vitest";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import {
  startRunnerApiHarness,
  TEST_LLM_API_KEY,
  TEST_LLM_MODEL,
} from "../../src/test-support/runner-api-harness.ts";
import { createContractValidator } from "../../src/test-support/runner-contract.ts";

const contract = createContractValidator();
const DYNAMIC = ["opencode"];

/** A harness wired like the server, with the project of the first repository switched on and its limit set. */
async function start(
  options: {
    dynamic?: boolean;
    project?: number | null;
    workspace?: number | null;
  } = {},
) {
  const h = await startRunnerApiHarness({ projects: true });
  await h.projectService.activateProject(h.repositoryId);
  if (options.workspace !== undefined && options.workspace !== null)
    await h.reviewSettings.updateGlobalSettings(
      { maxCostCents: options.workspace },
      "octocat",
    );
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    ...(options.dynamic === true ? { reviewKind: "dynamic" as const } : {}),
    ...(options.project === undefined || options.project === null
      ? {}
      : { maxCostCents: options.project }),
  });
  await h.enqueueNew();
  return h;
}

function claimOf(dynamic: boolean, features: string[]) {
  return {
    engines: dynamic ? DYNAMIC : ["pr-agent"],
    features,
  };
}

describe.each([
  { kind: "Diff Review", dynamic: false },
  { kind: "Dynamic Review", dynamic: true },
])("the cost limit of a $kind", ({ dynamic }) => {
  // #666-T01
  it("is the project's limit, in US dollars, in the LLM access of the job", async () => {
    const h = await start({ dynamic, project: 250 });

    const body = await h.claimed(claimOf(dynamic, ["cost_limit"]));

    expect(body.job.input.llm).toMatchObject({
      apiKey: TEST_LLM_API_KEY,
      maxCostUsd: 2.5,
    });
    expect(contract.check("ClaimResponse", body)).toStrictEqual({
      valid: true,
      errors: "",
    });
  });

  // #666-T01
  it("is the workspace default when the project sets none, and the project's own value when it does", async () => {
    const inherited = await start({ dynamic, workspace: 100 });
    const own = await start({ dynamic, workspace: 100, project: 40 });

    const first = await inherited.claimed(claimOf(dynamic, ["cost_limit"]));
    const second = await own.claimed(claimOf(dynamic, ["cost_limit"]));

    expect(first.job.input.llm.maxCostUsd).toBe(1);
    expect(second.job.input.llm.maxCostUsd).toBe(0.4);
  });

  // #666-T01: whole cents, so a dollar amount of the wire is exact (0.07 and not 0.07000000000000001).
  it.each([
    [1, 0.01],
    [7, 0.07],
    [299, 2.99],
    [10_000, 100],
  ])("sends %i cents as %f dollars", async (cents, dollars) => {
    const h = await start({ dynamic, project: cents });

    const body = await h.claimed(claimOf(dynamic, ["cost_limit"]));

    expect(body.job.input.llm.maxCostUsd).toBe(dollars);
  });

  // #666-T02
  it("is left out of the job when no limit is set, which is the job of today", async () => {
    const h = await start({ dynamic });

    // A runner of the previous release names no feature at all, and still gets the job.
    const body = await h.claimed({ engines: claimOf(dynamic, []).engines });

    expect(Object.keys(body.job.input.llm)).not.toContain("maxCostUsd");
  });

  // #666-T03: a refused review is worse than a limit that is not kept for the short window of a release, so the job runs with the
  // operator's own limit and without the project's, and the log says so. It never carries a field the runner would refuse.
  it("runs without the limit, and says so, on a runner that did not say it enforces it", async () => {
    const h = await start({ dynamic, project: 250 });

    const body = await h.claimed(
      claimOf(dynamic, dynamic ? ["dynamic_capabilities"] : []),
    );

    expect(Object.keys(body.job.input.llm)).not.toContain("maxCostUsd");
    expect(contract.check("ClaimResponse", body)).toStrictEqual({
      valid: true,
      errors: "",
    });
    expect(h.logLines().join("\n")).toContain(
      `job=${body.job.id} runs without its project cost limit`,
    );
  });

  // #666-T03: the hosted deployment: the Dispatcher claims the split answer, the Worker's own features decide at its fetch.
  it("runs on a Worker that did not say it enforces the limit without it, and sends it to one that did", async () => {
    const without = await start({ dynamic, project: 250 });
    const old = await without.startedWorker(undefined, undefined, {
      engines: claimOf(dynamic, []).engines,
    });

    expect(Object.keys(old.details.job.input.llm)).not.toContain("maxCostUsd");
    expect(await without.queue.get(old.jobId)).not.toMatchObject({
      status: "failed",
    });

    const accepted = await start({ dynamic, project: 250 });
    const started = await accepted.startedWorker("cost_limit", undefined, {
      engines: claimOf(dynamic, []).engines,
    });

    expect(started.details.job.input.llm.maxCostUsd).toBe(2.5);
  });
});

describe("a run that was stopped by the cost limit of its project", () => {
  const USAGE = {
    model: TEST_LLM_MODEL,
    promptTokens: 300,
    completionTokens: 30,
    totalTokens: 330,
    aiCalls: 3,
    fallbackUsed: false,
    costUsd: 0.0123,
  };

  // #666-T05
  it("settles a wrapped-up Dynamic Review with the cost it really had, and is a success that may be incomplete", async () => {
    const h = await start({ dynamic: true, project: 2 });
    const { job } = await h.claimed(claimOf(true, ["cost_limit"]));

    const response = await h.complete(job.id, job.leaseToken, {
      usage: { ...USAGE, stoppedEarly: "project_cost_limit" },
    });

    expect(response.status).toBe(200);
    expect(await h.queue.get(job.id)).toMatchObject({ status: "succeeded" });
    expect(
      await createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now).get(
        job.id,
      ),
    ).toMatchObject({ state: "settled", costMicroUsd: 12_300 });
  });

  // #666-T05
  it("settles a Diff Review that sent no further request with the cost of the calls it made", async () => {
    const h = await start({ project: 2 });
    const { job } = await h.claimed(claimOf(false, ["cost_limit"]));

    const response = await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "cost_limit_reached",
      errorMessage: "the cost limit of the project is reached",
      commentUrl: null,
      usage: { ...USAGE, stoppedEarly: null },
    });

    expect(response.status).toBe(200);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "cost_limit_reached",
    });
    expect(
      await createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now).get(
        job.id,
      ),
    ).toMatchObject({ state: "settled", costMicroUsd: 12_300 });
  });
});
