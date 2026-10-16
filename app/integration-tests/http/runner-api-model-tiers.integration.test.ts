// SPDX-License-Identifier: Apache-2.0

// The managed model tiers on both ways a job reaches a runner (#280): the legacy claim and the Worker API's first
// fetch. A job that runs on the operator's key (the workspace's key mode is `managed`) runs on the model the operator
// configured for the project's tier and the job's review kind, never on a model the workspace named; a tier without a
// model fails the job closed; a workspace on its own key is untouched. The model ids are operator data: they reach the
// runner and nothing a workspace member can read.
import { describe, expect, it } from "vitest";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import type {
  ModelCapabilityChecker,
  ModelCapabilityResult,
} from "../../src/llm/model-capabilities.ts";
import {
  UNKNOWN_WINDOW_MAX_TOKENS,
  type ManagedModelTiers,
} from "../../src/model-tiers/tiers.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";

const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
const WORKSPACE_KEY = "plain-workspace-key-0003-cccccccc";

// The ids below are made up for the test. Nothing in the repository names a real model for a tier.
const TIERS: ManagedModelTiers = {
  low: { diff: "tier/low-diff", dynamic: "tier/low-dyn" },
  medium: { diff: "tier/medium-diff", dynamic: "tier/medium-dyn" },
  high: { diff: "tier/high-diff", dynamic: "tier/high-dyn" },
};
const ALL_TIER_MODELS = Object.values(TIERS).flatMap((models) =>
  Object.values(models),
);

function supported(
  contextLength: number | null = 1_000_000,
): Extract<ModelCapabilityResult, { capabilities: unknown }> {
  return {
    outcome: "supported",
    capabilities: {
      tools: true,
      toolChoice: true,
      toolChoiceRequired: true,
      responseFormat: true,
      structuredOutputs: true,
      maxCompletionTokens: 393_216,
      smallestCompletionTokens: 131_072,
      contextLength,
      inputUsdPerMtok: "0.6",
      outputUsdPerMtok: "2.4",
    },
  };
}

/** A provider whose metadata answers per model; the models asked about are recorded. */
function provider(answer: (model: string) => ModelCapabilityResult) {
  const asked: string[] = [];
  const checker: ModelCapabilityChecker = {
    check: async (model) => {
      asked.push(model);
      return answer(model);
    },
  };
  return { asked, checker };
}

function entitlements(keyMode: "own" | "managed"): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
  };
}

type Options = {
  /** `null`: the workspace has no entitlements at all (unlimited). */
  keyMode: "own" | "managed" | null;
  tiers?: ManagedModelTiers;
  dynamic?: boolean;
  /** The settings the project saves, on top of its kind. */
  project?: Record<string, unknown>;
  /** The workspace defaults. */
  defaults?: Record<string, unknown>;
  harness?: Parameters<typeof startRunnerApiHarness>[0];
};

/** A workspace with an active project, a queued job, the operator's key and (optionally) the tiers. */
async function start({
  keyMode,
  tiers = TIERS,
  dynamic = false,
  project = {},
  defaults,
  harness = {},
}: Options): Promise<RunnerApiHarness> {
  const h = await startRunnerApiHarness({
    llmKey: WORKSPACE_KEY,
    projects: true,
    modelTiers: tiers,
    env: { LLM_MODEL: "vendor/instance-model", LLM_MAX_TOKENS: "64000" },
    ...harness,
  });
  const saved = await h.llm.operatorKey().save({ apiKey: OPERATOR_KEY }, null);
  expect(saved.ok).toBe(true);
  if (keyMode !== null)
    await createWorkspaceEntitlementsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).put(entitlements(keyMode), null);
  await h.projectService.activateProject(h.repositoryId);
  if (defaults !== undefined)
    await h.reviewSettings.updateGlobalSettings(defaults, "operator");
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    ...project,
    ...(dynamic ? { reviewKind: "dynamic" as const } : {}),
  });
  await h.enqueueNew();
  return h;
}

const DYNAMIC_CLAIM = {
  engines: ["opencode"],
  features: ["dynamic_capabilities"],
};

async function recordOf(h: RunnerApiHarness, jobId: string) {
  return createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now).get(
    jobId,
  );
}

describe("the model of a Diff job on the operator's key", () => {
  // #280-T04
  it("is the model of the project's tier for Diff, on the legacy claim, and the usage record names the tier", async () => {
    const h = await start({
      keyMode: "managed",
      project: { modelTier: "high" },
    });

    const { job } = await h.claimed();

    expect(job.input.llm).toMatchObject({
      provider: "openrouter",
      model: "tier/high-diff",
      apiKey: OPERATOR_KEY,
    });
    expect(await recordOf(h, job.id)).toMatchObject({
      keyMode: "managed",
      modelTier: "high",
    });
  });

  // #280-T04
  it("is the same on the Worker's first fetch", async () => {
    const h = await start({
      keyMode: "managed",
      project: { modelTier: "low" },
    });

    const { jobId, details } = await h.startedWorker();

    expect(details.job.input.llm).toMatchObject({
      model: "tier/low-diff",
      apiKey: OPERATOR_KEY,
    });
    expect(await recordOf(h, jobId)).toMatchObject({ modelTier: "low" });
  });

  // #280-T10
  it("is the medium tier's model when nothing sets a tier", async () => {
    const h = await start({ keyMode: "managed" });

    const { job } = await h.claimed();

    expect(job.input.llm.model).toBe("tier/medium-diff");
    expect(await recordOf(h, job.id)).toMatchObject({ modelTier: "medium" });
  });

  // #280-T10
  it("follows the workspace default tier, and the project's own tier wins over it", async () => {
    const inherited = await start({
      keyMode: "managed",
      defaults: { modelTier: "low" },
    });
    expect((await inherited.claimed()).job.input.llm.model).toBe(
      "tier/low-diff",
    );

    const own = await start({
      keyMode: "managed",
      defaults: { modelTier: "low" },
      project: { modelTier: "high" },
    });
    expect((await own.claimed()).job.input.llm.model).toBe("tier/high-diff");
  });

  // #280-T04
  it("replaces whatever model the workspace's settings name, which stay stored", async () => {
    const h = await start({
      keyMode: "managed",
      project: {
        model: "vendor/project-model",
        fallbackModel: "vendor/fallback-model",
        dynamicModel: "vendor/dynamic-model",
        modelTier: "high",
      },
    });

    const { job } = await h.claimed();

    const text = JSON.stringify(job.input);
    expect(job.input.llm.model).toBe("tier/high-diff");
    for (const named of [
      "vendor/project-model",
      "vendor/fallback-model",
      "vendor/dynamic-model",
      "vendor/instance-model",
    ])
      expect(text).not.toContain(named);
    expect(
      (await h.reviewSettings.resolveForRepository(h.repositoryId))?.settings,
    ).toMatchObject({ model: "vendor/project-model", modelTier: "high" });
  });

  it("changes with the operator's configuration at the next claim, without any workspace choosing again", async () => {
    const h = await start({
      keyMode: "managed",
      project: { modelTier: "high" },
    });
    await h.setTiers({ ...TIERS, high: { diff: "tier/high-diff-v2" } });

    const { job } = await h.claimed();

    expect(job.input.llm.model).toBe("tier/high-diff-v2");
  });
});

describe("the model of a Dynamic job on the operator's key", () => {
  // #280-T05
  it("is the tier's Dynamic model in the job and in the Dynamic options, with the capabilities read for that model", async () => {
    const meta = provider(() => supported());
    const h = await start({
      keyMode: "managed",
      dynamic: true,
      project: { modelTier: "high", dynamicModel: "vendor/dynamic-model" },
      harness: { modelCapabilities: meta.checker },
    });

    const { job } = await h.claimed(DYNAMIC_CLAIM);

    expect(job.input).toMatchObject({
      reviewKind: "dynamic",
      llm: { model: "tier/high-dyn", apiKey: OPERATOR_KEY },
      dynamic: {
        model: "tier/high-dyn",
        capabilities: { contextWindowTokens: 1_000_000 },
      },
    });
    expect(JSON.stringify(job.input)).not.toContain("vendor/dynamic-model");
    expect(meta.asked).toEqual(["tier/high-dyn"]);
    expect(await recordOf(h, job.id)).toMatchObject({
      modelTier: "high",
      reviewKind: "dynamic",
    });
  });

  // #280-T05
  it("is the same on the Worker's first fetch", async () => {
    const meta = provider(() => supported());
    const h = await start({
      keyMode: "managed",
      dynamic: true,
      project: { modelTier: "low" },
      harness: { modelCapabilities: meta.checker },
    });
    const claim = await h.claimedSplit({
      engines: ["opencode"],
      features: ["dynamic_capabilities"],
    });

    const response = await h.worker.details(
      claim.job.id,
      claim.job.credential,
      "dynamic_capabilities",
    );
    const details = await response.json();

    expect(response.status).toBe(200);
    expect(details.job.input).toMatchObject({
      llm: { model: "tier/low-dyn" },
      dynamic: { model: "tier/low-dyn" },
    });
    expect(await recordOf(h, claim.job.id)).toMatchObject({ modelTier: "low" });
  });

  it("still ends a job whose tier model lacks tool calling, as before", async () => {
    const meta = provider(() => ({
      outcome: "unsupported",
      capabilities: { ...supported().capabilities!, tools: false },
    }));
    const h = await start({
      keyMode: "managed",
      dynamic: true,
      harness: { modelCapabilities: meta.checker },
    });

    const response = await h.claim(DYNAMIC_CLAIM);

    expect(response.status).toBe(204);
    expect(await h.queue.get((await h.snapshotJobs())[0]!.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_model_features_unsupported",
    });
  });
});

describe("a tier without a model", () => {
  // #280-T06
  it("fails the job closed with managed_tier_unavailable, hands out no key and never moves to another tier", async () => {
    const h = await start({
      keyMode: "managed",
      tiers: {
        medium: { diff: "tier/medium-diff" },
        low: { dynamic: "tier/low-dyn" },
      },
      project: { modelTier: "high" },
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "managed_tier_unavailable",
    });
    // No key left, no repository token was made, and the record counts for nothing.
    expect(h.issuedJobTokens()).toEqual([]);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
    expect(await recordOf(h, job!.id)).toMatchObject({
      state: "void",
      modelTier: "high",
    });
    const written = h.logLines().join("\n");
    expect(written).toContain("managed_tier_unavailable");
    expect(written).toContain("tier=high");
    expect(written).not.toContain(OPERATOR_KEY);
    for (const model of [...ALL_TIER_MODELS, "vendor/instance-model", "tier/"])
      expect(written).not.toContain(model);
  });

  // #280-T06
  it("fails a kind the tier has no model for, even when another kind has one", async () => {
    const h = await start({
      keyMode: "managed",
      dynamic: true,
      tiers: { medium: { diff: "tier/medium-diff" } },
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim(DYNAMIC_CLAIM)).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "managed_tier_unavailable",
    });
  });

  // #280-T06
  it("fails with no tier configured at all, and does not fall back to the instance default model", async () => {
    const h = await start({ keyMode: "managed", tiers: {} });
    const [job] = await h.snapshotJobs();

    expect((await h.claim()).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "managed_tier_unavailable",
    });
  });

  // #280-T06
  it("ends the job on the Worker's first fetch when the operator removed the model since the claim, with no key and no token", async () => {
    const h = await start({
      keyMode: "managed",
      tiers: { low: { diff: "tier/low-diff" } },
      project: { modelTier: "low" },
    });
    const claim = await h.claimedSplit();
    // The Dispatcher's claim passed; the operator takes the model away before the Worker fetches the job.
    await h.setTiers({ medium: { diff: "tier/medium-diff" } });

    const response = await h.worker.details(claim.job.id, claim.job.credential);
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "RUNNER_JOB_ENDED" },
    });
    expect(text).not.toContain(OPERATOR_KEY);
    expect(await h.queue.get(claim.job.id)).toMatchObject({
      status: "failed",
      errorCode: "managed_tier_unavailable",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #280-T06
  it("ends a Dispatcher's job at its claim, before any credential exists", async () => {
    const h = await start({ keyMode: "managed", tiers: {} });
    const [job] = await h.snapshotJobs();

    expect((await h.claimSplit()).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "managed_tier_unavailable",
    });
  });
});

describe("a workspace that is not on the operator's key", () => {
  const CHOSEN = {
    model: "vendor/project-model",
    maxTokens: 50_000,
    dynamicModel: "vendor/dynamic-model",
    modelTier: "high",
  };

  // #280-T07
  it.each([
    ["own", "own" as const],
    ["without entitlements (unlimited)", null],
  ])(
    "keeps the project's own model and ignores the tier: %s",
    async (_name, keyMode) => {
      const h = await start({ keyMode, project: CHOSEN });

      const { job } = await h.claimed();

      expect(job.input.llm).toStrictEqual({
        provider: "openrouter",
        model: "vendor/project-model",
        apiKey: WORKSPACE_KEY,
        maxTokens: 50_000,
      });
      expect(JSON.stringify(job.input)).not.toContain("tier/");
      expect(await recordOf(h, job.id)).toMatchObject({
        keyMode: "own",
        modelTier: null,
      });
    },
  );

  // #280-T07
  it("keeps the project's Dynamic model, and needs no tier configured", async () => {
    const h = await start({
      keyMode: "own",
      dynamic: true,
      tiers: {},
      project: CHOSEN,
    });

    const { job } = await h.claimed({ engines: ["opencode"] });

    expect(job.input).toMatchObject({
      llm: { model: "vendor/dynamic-model", apiKey: WORKSPACE_KEY },
      dynamic: { model: "vendor/dynamic-model" },
    });
  });

  // #280-T07
  it("is the same on the Worker's fetch, and a tier that is not configured does not matter", async () => {
    const h = await start({ keyMode: "own", tiers: {}, project: CHOSEN });

    const { details } = await h.startedWorker();

    expect(details.job.input.llm).toMatchObject({
      model: "vendor/project-model",
      apiKey: WORKSPACE_KEY,
    });
  });
});

describe("the token budget of a job on the operator's key", () => {
  // #280-T09
  it("is cut to the documented bound when the tier model's window is not known and the provider is not asked", async () => {
    const h = await start({
      keyMode: "managed",
      project: { maxTokens: 150_000, modelTier: "high" },
    });

    const { job } = await h.claimed();

    expect(job.input.llm.maxTokens).toBe(UNKNOWN_WINDOW_MAX_TOKENS);
  });

  // #280-T09
  it("is the workspace's budget when it is below the bound and no window is known", async () => {
    const h = await start({
      keyMode: "managed",
      project: { maxTokens: 50_000 },
    });

    expect((await h.claimed()).job.input.llm.maxTokens).toBe(50_000);
  });

  // #280-T09
  it("uses the last window read for the model when the provider cannot be asked now", async () => {
    let answer: ModelCapabilityResult = supported(64_000);
    const asked: Array<{ model: string; options: unknown }> = [];
    let known: number | null = null;
    const checker: ModelCapabilityChecker = {
      check: async (model, options) => {
        asked.push({ model, options });
        if (answer.outcome === "supported") known = 64_000;
        return answer;
      },
      lastKnownContextLength: () => known,
    };
    const h = await start({
      keyMode: "managed",
      project: { maxTokens: 150_000, modelTier: "high" },
      harness: { modelCapabilities: checker },
    });
    expect((await h.claimed()).job.input.llm.maxTokens).toBe(64_000);
    answer = { outcome: "unverifiable" };
    await h.enqueueNew({ prNumber: 8 });

    expect((await h.claimed()).job.input.llm.maxTokens).toBe(64_000);
    // The claim asks as a claim, and names the tier, not the model, in the log line.
    expect(asked[1]).toEqual({
      model: "tier/high-diff",
      options: { forClaim: true, logAs: "tier=high" },
    });
  });

  // #280-T09
  it("is clamped to the context window of the tier's Diff model", async () => {
    const meta = provider((model) =>
      supported(model === "tier/high-diff" ? 64_000 : 1_000_000),
    );
    const h = await start({
      keyMode: "managed",
      project: { maxTokens: 150_000, modelTier: "high" },
      harness: { modelCapabilities: meta.checker },
    });

    const { job } = await h.claimed();

    expect(job.input.llm.maxTokens).toBe(64_000);
    expect(meta.asked).toEqual(["tier/high-diff"]);
  });

  // #280-T09
  it("is clamped to the context window of the tier's Dynamic model, with one read of its metadata", async () => {
    const meta = provider(() => supported(100_000));
    const h = await start({
      keyMode: "managed",
      dynamic: true,
      project: { maxTokens: 150_000, modelTier: "low" },
      harness: { modelCapabilities: meta.checker },
    });

    const { job } = await h.claimed(DYNAMIC_CLAIM);

    expect(job.input.llm.maxTokens).toBe(100_000);
    expect(meta.asked).toEqual(["tier/low-dyn"]);
  });

  // #280-T09
  it("stays as it is when the budget fits the window", async () => {
    const meta = provider(() => supported(200_000));
    const h = await start({
      keyMode: "managed",
      project: { maxTokens: 120_000 },
      harness: { modelCapabilities: meta.checker },
    });

    expect((await h.claimed()).job.input.llm.maxTokens).toBe(120_000);
  });

  // #280-T09
  it("is cut to the bound when the provider cannot be asked and no window was ever read", async () => {
    const meta = provider(() => ({ outcome: "unverifiable" }));
    const h = await start({
      keyMode: "managed",
      project: { maxTokens: 150_000 },
      harness: { modelCapabilities: meta.checker },
    });

    expect((await h.claimed()).job.input.llm.maxTokens).toBe(
      UNKNOWN_WINDOW_MAX_TOKENS,
    );
  });

  // #280-T09
  it("is not clamped for a workspace on its own key, and the provider is not asked for a Diff model", async () => {
    const meta = provider(() => supported(8_000));
    const h = await start({
      keyMode: "own",
      project: { maxTokens: 150_000, model: "vendor/own-model" },
      harness: { modelCapabilities: meta.checker },
    });

    expect((await h.claimed()).job.input.llm.maxTokens).toBe(150_000);
    expect(meta.asked).toEqual([]);
  });
});

describe("the model of a tier stays on the server", () => {
  const SECRET_HINT = "tier/high-diff";

  /** A completed run of a managed job: the runner reports the model it used, as it does. */
  async function completedRun(h: RunnerApiHarness) {
    const { job } = await h.claimed();
    const completed = await h.complete(job.id, job.leaseToken, {
      logTail: `calling openrouter/${SECRET_HINT} with ${SECRET_HINT}`,
      errorMessage: null,
      usage: {
        model: `openrouter/${SECRET_HINT}`,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        aiCalls: 1,
        fallbackUsed: false,
        costUsd: 0.01,
        stoppedEarly: null,
      },
    });
    expect(completed.status).toBe(200);
    return job.id;
  }

  // #280-T08
  it("is not in the stored result of a run, not even after the operator changed the tier since the claim", async () => {
    const h = await start({
      keyMode: "managed",
      project: { modelTier: "high" },
    });
    const { job } = await h.claimed();
    await h.setTiers({ high: { diff: "tier/high-diff-v2" } });

    await h.anotherInstance().complete(job.id, job.leaseToken, {
      logTail: `calling openrouter/${SECRET_HINT} with ${SECRET_HINT}`,
      usage: {
        model: `openrouter/${SECRET_HINT}`,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        aiCalls: 1,
        fallbackUsed: false,
        costUsd: 0.01,
        stoppedEarly: null,
      },
    });

    const stored = JSON.stringify((await h.queue.get(job.id))?.result);
    expect(stored).not.toContain(SECRET_HINT);
    expect(stored).toContain("[redacted]");
    // The cost and the tokens of the run are still there.
    expect(JSON.parse(stored).usage).toMatchObject({
      model: null,
      promptTokens: 10,
      costUsd: 0.01,
    });
  });

  // #280-T08
  it("is not in a log line, a job row, a usage record or a key row", async () => {
    const h = await start({
      keyMode: "managed",
      project: { modelTier: "high" },
    });
    const jobId = await completedRun(h);

    const everything = [
      ...h.logLines(),
      JSON.stringify(await h.snapshotJobs()),
      JSON.stringify(
        await h.db.selectFrom("usage_records").selectAll().execute(),
      ),
    ].join("\n");
    for (const model of ALL_TIER_MODELS)
      expect(everything).not.toContain(model);
    expect(await recordOf(h, jobId)).toMatchObject({
      modelTier: "high",
      state: "settled",
    });
  });

  const usageOf = (model: string) => ({
    model,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    aiCalls: 1,
    fallbackUsed: false,
    costUsd: 0.01,
    stoppedEarly: null,
  });

  // #280-T08
  it("is never reported as the model of a run on a tier, whatever the runner calls it", async () => {
    const h = await start({
      keyMode: "managed",
      project: { modelTier: "high" },
    });
    const { job } = await h.claimed();

    await h.complete(job.id, job.leaseToken, {
      // A dated, canonical spelling of the model that is not the id the job was handed.
      usage: usageOf("openrouter/other-slug/tier-high-diff-20261001"),
    });

    const stored = (await h.queue.get(job.id))?.result as {
      usage: { model: string | null; promptTokens: number };
    };
    expect(stored.usage).toMatchObject({ model: null, promptTokens: 10 });
  });

  // #280-T08
  it("masks the models the operator has configured now as well as the one the job was handed", async () => {
    const h = await start({
      keyMode: "managed",
      project: { modelTier: "high" },
    });
    const { job } = await h.claimed();
    await h.setTiers({ ...TIERS, high: { diff: "tier/high-diff-v2" } });

    await h.complete(job.id, job.leaseToken, {
      logTail: "handed tier/high-diff, now tier/high-diff-v2 and tier/low-dyn",
    });

    const stored = JSON.stringify((await h.queue.get(job.id))?.result);
    for (const model of ["tier/high-diff", "tier/low-dyn"])
      expect(stored).not.toContain(model);
    expect(stored).not.toContain("tier/");
  });

  // #280-T08
  it("still hides the model when the sealed row of the job cannot be read", async () => {
    const h = await start({
      keyMode: "managed",
      project: { modelTier: "high" },
    });
    const { job } = await h.claimed();
    await h.db.updateTable("job_claimed_keys").set({ nonce: "AAAA" }).execute();
    expect(await h.claimedKeys.modelsOf(job.id)).toEqual([]);

    await h.complete(job.id, job.leaseToken, {
      logTail: "model tier/high-diff answered",
      usage: usageOf("openrouter/tier/high-diff"),
    });

    const stored = JSON.stringify((await h.queue.get(job.id))?.result);
    expect(stored).not.toContain("tier/");
    expect(JSON.parse(stored).usage.model).toBeNull();
    expect(stored).toContain("[redacted] answered");
  });

  // #280-T08
  it("keeps reporting the model of a run on the workspace's own key, even when it looks like a tier model", async () => {
    const h = await start({
      keyMode: "own",
      project: { model: "tier/high-diff" },
    });
    const { job } = await h.claimed();

    await h.complete(job.id, job.leaseToken, {
      usage: usageOf("openrouter/tier/high-diff"),
    });

    const stored = (await h.queue.get(job.id))?.result as {
      usage: { model: string };
    };
    expect(stored.usage.model).toBe("openrouter/tier/high-diff");
  });

  // #280-T08
  it("is masked in the text of a result even when the id is too short for the generic secret rule", async () => {
    const h = await start({
      keyMode: "managed",
      tiers: { medium: { diff: "ab/c" } },
    });
    const { job } = await h.claimed();

    await h.complete(job.id, job.leaseToken, {
      logTail: "model ab/c answered",
      errorMessage: "ab/c is busy",
    });

    const stored = JSON.stringify((await h.queue.get(job.id))?.result);
    expect(stored).not.toContain("ab/c");
    expect(stored).toContain("[redacted] answered");
  });

  it("is kept encrypted for the masking, and a run on the workspace's own key reports its model as before", async () => {
    const h = await start({
      keyMode: "managed",
      project: { modelTier: "high" },
    });
    const { job } = await h.claimed();
    expect(
      JSON.stringify(
        await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
      ),
    ).not.toContain(SECRET_HINT);
    expect(await h.claimedKeys.modelsOf(job.id)).toEqual([SECRET_HINT]);
    expect(await h.claimedKeys.keysOf(job.id)).toEqual([OPERATOR_KEY]);

    const own = await start({
      keyMode: "own",
      project: { model: "vendor/own-model" },
    });
    const { job: ownJob } = await own.claimed();
    await own.complete(ownJob.id, ownJob.leaseToken, {
      usage: {
        model: "openrouter/vendor/own-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        aiCalls: 1,
        fallbackUsed: false,
        costUsd: 0.001,
        stoppedEarly: null,
      },
    });
    const ownResult = (await own.queue.get(ownJob.id))?.result as {
      usage?: { model?: string };
    } | null;
    expect(ownResult?.usage?.model).toBe("openrouter/vendor/own-model");
    expect(await own.claimedKeys.modelsOf(ownJob.id)).toEqual([]);
  });
});
