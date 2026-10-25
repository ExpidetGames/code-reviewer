// SPDX-License-Identifier: LicenseRef-Proprietary

// The cost limit of a project at claim time (#666): the review settings resolve `maxCostCents` (the project's value over the
// workspace default over none), and the claim hands it to the runner as `llm.maxCostUsd`, on both ways a job reaches a runner
// (the legacy claim and the Worker API's first fetch) and for both kinds of review. A runner that did not say it enforces the
// limit (the claim feature `cost_limit`) never gets the field (the job is closed): it runs with the operator's limit alone and the
// log says so, since a refused review is worse than an unenforced limit while a release is rolling out. A job without a limit is
// the job of today, byte for byte.
//
// The operator's maximum per review (#689, the admin portal) is the second value: the claim hands it over as
// `llm.operatorMaxCostUsd` to a runner that names `operator_cost_limit`, folds the smaller of the two into `llm.maxCostUsd` for one
// that names `cost_limit` alone, and sends neither to one that names neither.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
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
    /** The operator's maximum per review in cents. Default: 100 USD, the top of the range, so a limit below it is the smaller one. */
    operator?: number;
  } = {},
) {
  const h = await startRunnerApiHarness({ projects: true });
  await createInstanceSettingsRepository(h.db).set(
    "review_max_cost_cents",
    options.operator ?? 10_000,
    null,
  );
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
  // runner's own limit and without the project's, and the log says so. It never carries a field the runner would refuse.
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
    expect(Object.keys(body.job.input.llm)).not.toContain("operatorMaxCostUsd");
    expect(h.logLines().join("\n")).toContain(
      `job=${body.job.id} carries no cost limit`,
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

// #689
describe.each([
  { kind: "Diff Review", dynamic: false },
  { kind: "Dynamic Review", dynamic: true },
])("the operator's maximum cost per review of a $kind", ({ dynamic }) => {
  const BOTH = ["cost_limit", "operator_cost_limit"];

  // #689-T11
  it("is 1.00 USD in the job of a runner that reads it, until the admin sets another, and is there without a limit of the customer's", async () => {
    const h = await startRunnerApiHarness({ projects: true });
    await h.projectService.activateProject(h.repositoryId);
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      ...(dynamic ? { reviewKind: "dynamic" as const } : {}),
    });
    await h.enqueueNew();

    const body = await h.claimed(claimOf(dynamic, BOTH));

    expect(body.job.input.llm.operatorMaxCostUsd).toBe(1);
    expect(Object.keys(body.job.input.llm)).not.toContain("maxCostUsd");
    expect(contract.check("ClaimResponse", body)).toStrictEqual({
      valid: true,
      errors: "",
    });
  });

  // #689-T11
  it("travels beside the customer's limit as its own value, so the runner can tell whose limit stopped a review", async () => {
    const h = await start({ dynamic, project: 40, operator: 250 });

    const body = await h.claimed(claimOf(dynamic, BOTH));

    expect(body.job.input.llm).toMatchObject({
      maxCostUsd: 0.4,
      operatorMaxCostUsd: 2.5,
    });
    expect(contract.check("ClaimResponse", body)).toStrictEqual({
      valid: true,
      errors: "",
    });
  });

  // #689-T07, #689-T11: the admin lowered the maximum below a limit the customer saved earlier
  it("is sent as it is now, below a limit a customer saved when it was higher: the lower one wins at the runner", async () => {
    const both = await start({ dynamic, project: 500, operator: 1000 });
    const folded = await start({ dynamic, project: 500, operator: 1000 });
    for (const h of [both, folded])
      await createInstanceSettingsRepository(h.db).set(
        "review_max_cost_cents",
        100,
        null,
      );

    const first = await both.claimed(claimOf(dynamic, BOTH));
    const second = await folded.claimed(claimOf(dynamic, ["cost_limit"]));

    expect(first.job.input.llm).toMatchObject({
      maxCostUsd: 5,
      operatorMaxCostUsd: 1,
    });
    // A runner of the release before reads one value, and gets the smaller.
    expect(second.job.input.llm.maxCostUsd).toBe(1);
  });

  // #689-T12
  it("is folded into the one limit a runner of the release before reads, when the customer set none too", async () => {
    const h = await start({ dynamic, operator: 150 });

    const body = await h.claimed(claimOf(dynamic, ["cost_limit"]));

    expect(body.job.input.llm.maxCostUsd).toBe(1.5);
    expect(Object.keys(body.job.input.llm)).not.toContain("operatorMaxCostUsd");
    expect(contract.check("ClaimResponse", body)).toStrictEqual({
      valid: true,
      errors: "",
    });
  });

  // #689-T12
  it("is not sent to a runner that names neither feature: its job is the job of before", async () => {
    const h = await start({ dynamic, project: 40, operator: 150 });

    const body = await h.claimed({ engines: claimOf(dynamic, []).engines });

    expect(Object.keys(body.job.input.llm)).not.toContain("maxCostUsd");
    expect(Object.keys(body.job.input.llm)).not.toContain("operatorMaxCostUsd");
  });

  // #689-T11: the hosted deployment: the Worker's own features decide at its fetch
  it("is sent to a Worker that names the feature, and not to one that does not", async () => {
    const accepted = await start({ dynamic, operator: 175 });
    const reads = await accepted.startedWorker(
      "operator_cost_limit",
      undefined,
      { engines: claimOf(dynamic, []).engines },
    );
    const other = await start({ dynamic, operator: 175 });
    const old = await other.startedWorker(undefined, undefined, {
      engines: claimOf(dynamic, []).engines,
    });

    expect(reads.details.job.input.llm.operatorMaxCostUsd).toBe(1.75);
    expect(Object.keys(old.details.job.input.llm)).not.toContain(
      "operatorMaxCostUsd",
    );
  });

  // #689-T10: nothing is held back: a damaged setting reads as the default
  it("reads a damaged setting as 1.00 USD, never as no limit", async () => {
    const h = await start({ dynamic, operator: 150 });
    await createInstanceSettingsRepository(h.db).set(
      "review_max_cost_cents",
      0 as number,
      null,
    );

    const body = await h.claimed(claimOf(dynamic, BOTH));

    expect(body.job.input.llm.operatorMaxCostUsd).toBe(1);
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
