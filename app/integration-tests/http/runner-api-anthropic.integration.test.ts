// SPDX-License-Identifier: Apache-2.0

// #511-T12: the claim of a job whose provider is Anthropic (the real adapter, not a test double). A workspace on its own
// key runs on the provider and model its project names with the key of that provider and no other; the model's
// capabilities come from the adapter's list, so a Dynamic job carries the descriptor of the listed model and a model
// that cannot serve a Dynamic Review is refused before the runner sees the job. A workspace on the operator's key runs
// on its catalog entry with the operator's key of the Anthropic provider.
import { describe, expect, it } from "vitest";
import { createModelCapabilityChecker } from "../../src/llm/model-capabilities.ts";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";

const OPENROUTER_KEY = "plain-openrouter-key-0001-aaaaaaaa";
const ANTHROPIC_KEY = "dummy-anthropic-plain-workspace-key-0002-bbbbbbbbbbbb";
const OPERATOR_ANTHROPIC_KEY = "dummy-anthropic-plain-operator-key-0003-cccccccccc";
const OPERATOR_OPENROUTER_KEY = "plain-operator-openrouter-0004-dddddd";
const BOTH = ["openrouter", "anthropic"];
const DYNAMIC_CLAIM = {
  engines: ["opencode"],
  features: ["dynamic_capabilities"],
  llmProviders: BOTH,
};

function entitlements(keyMode: "own" | "managed"): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
  };
}

async function start(options: {
  keyMode: "own" | "managed";
  dynamic?: boolean;
  project?: Record<string, unknown>;
  prepare?: (h: RunnerApiHarness) => Promise<Record<string, unknown> | void>;
  anthropicKey?: string | null;
}): Promise<RunnerApiHarness> {
  const h = await startRunnerApiHarness({
    llmKey: OPENROUTER_KEY,
    projects: true,
    env: { LLM_MODEL: "vendor/instance-model", LLM_MAX_TOKENS: "64000" },
    // The real adapters, asked for the capabilities of a listed model: the answer comes from the list.
    modelCapabilities: createModelCapabilityChecker({
      baseUrl: () => "http://llm.invalid/v1",
      log: () => undefined,
    }),
  });
  if (options.anthropicKey !== null)
    await h.setLlmKey(options.anthropicKey ?? ANTHROPIC_KEY, "anthropic");
  for (const [provider, apiKey] of [
    ["openrouter", OPERATOR_OPENROUTER_KEY],
    ["anthropic", OPERATOR_ANTHROPIC_KEY],
  ] as const) {
    const saved = await h.llm.operatorKey().save({ provider, apiKey }, null);
    expect(saved.ok).toBe(true);
  }
  const prepared = (await options.prepare?.(h)) ?? {};
  await createWorkspaceEntitlementsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).put(entitlements(options.keyMode), null);
  await h.projectService.activateProject(h.repositoryId);
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    ...(options.project ?? {}),
    ...prepared,
    ...(options.dynamic === true ? { reviewKind: "dynamic" as const } : {}),
  });
  await h.enqueueNew();
  return h;
}

describe("a job on the Anthropic provider, own key", () => {
  // #511-T12
  it("carries the provider, the model and the key of that provider, and no other key", async () => {
    const h = await start({
      keyMode: "own",
      project: { provider: "anthropic", model: "claude-haiku-5-5" },
    });

    const { job } = await h.claimed({ llmProviders: BOTH });

    expect(job.input.llm).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      apiKey: ANTHROPIC_KEY,
    });
    const text = JSON.stringify(job.input);
    expect(text).not.toContain(OPENROUTER_KEY);
    expect(text).not.toContain(OPERATOR_ANTHROPIC_KEY);
    expect(text).not.toContain("openrouter");
  });

  // #511-T12
  it("fails with llm_not_configured when the workspace has no key for the provider, and never uses the other provider's key", async () => {
    const h = await start({
      keyMode: "own",
      anthropicKey: null,
      project: { provider: "anthropic", model: "claude-haiku-5-5" },
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim({ llmProviders: BOTH })).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.logLines().join("\n")).not.toContain(OPENROUTER_KEY);
  });

  // #511-T12
  it("hands a Dynamic job the capabilities of the listed model", async () => {
    const h = await start({
      keyMode: "own",
      dynamic: true,
      project: {
        dynamicProvider: "anthropic",
        dynamicModel: "claude-sonnet-5",
      },
    });

    const { job } = await h.claimed(DYNAMIC_CLAIM);

    expect(job.input).toMatchObject({
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        apiKey: ANTHROPIC_KEY,
      },
      dynamic: {
        model: "claude-sonnet-5",
        capabilities: {
          toolChoiceRequired: true,
          structuredOutput: true,
          maxOutputTokens: 8192,
          contextWindowTokens: 1_000_000,
          inputUsdPerMtok: "2",
          outputUsdPerMtok: "10",
        },
      },
    });
  });

  // #511-T12
  it("refuses a Dynamic job on a model that takes no forced tool choice, before the runner sees it", async () => {
    const h = await start({
      keyMode: "own",
      dynamic: true,
      project: {
        dynamicProvider: "anthropic",
        dynamicModel: "claude-sonnet-5-5",
      },
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim(DYNAMIC_CLAIM)).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_model_features_unsupported",
    });
  });

  // #511-T12
  it("is not sent to a runner that did not advertise the provider", async () => {
    const h = await start({
      keyMode: "own",
      project: { provider: "anthropic", model: "claude-haiku-5-5" },
    });

    const answer = await h.claim({ llmProviders: ["openrouter"] });

    expect(answer.status).toBe(204);
  });
});

describe("a job on the Anthropic provider, operator's key", () => {
  // #511-T12
  it("runs on the catalog entry's model with the operator's key of the Anthropic provider", async () => {
    const h = await start({
      keyMode: "managed",
      prepare: async (app) => ({
        catalogEntryDiff: (
          await app.catalogEntryFor("anthropic", {
            name: "Quick",
            modelId: "claude-haiku-5-5",
          })
        ).id,
      }),
    });

    const { job } = await h.claimed({ llmProviders: BOTH });

    expect(job.input.llm).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      apiKey: OPERATOR_ANTHROPIC_KEY,
    });
    expect(JSON.stringify(job.input)).not.toContain(ANTHROPIC_KEY);
    expect(
      await createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now).get(
        job.id,
      ),
    ).toMatchObject({
      keyMode: "managed",
      catalogEntryName: "Quick",
      llmProvider: "anthropic",
    });
  });
});
