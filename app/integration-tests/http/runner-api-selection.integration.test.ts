// SPDX-License-Identifier: Apache-2.0

// What a job runs on, on both ways it reaches a runner (#432, ADR 0005, 2.8): the legacy claim and the Worker API's first
// fetch. The resolver (`resolveModelSelection`) chooses provider, model and key before any key is loaded. A workspace on
// its own key runs on the provider and model its settings name, with the key of that provider; a workspace on the
// operator's key runs on the catalog entry its project selected (else the instance default), with the operator's key of the
// entry's provider, and the model of the entry stays on the server. The model ids used below are made up for the test.
import { describe, expect, it } from "vitest";
import {
  createFakeAdapter,
  FAKE_PROVIDER_ID,
} from "../../src/llm/providers/fake-adapter.ts";
import { openrouterDescriptor } from "../../src/llm/providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "../../src/llm/providers/registry.ts";
import type {
  ModelCapabilityChecker,
  ModelCapabilityResult,
} from "../../src/llm/model-capabilities.ts";
import { createAppSettingsRepository } from "../../src/db/repositories/app-settings-repository.ts";
import { REVIEW_DEFAULTS_KEY } from "../../src/review-settings/service.ts";
import type { ProjectSettings } from "../../src/db/repositories/projects-repository.ts";
import { createProjectsRepository } from "../../src/db/repositories/projects-repository.ts";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import { MAX_PROVIDER_TEXT_CHARS } from "../../src/llm/provider-text.ts";
import { UNKNOWN_WINDOW_MAX_TOKENS } from "../../src/model-tiers/tiers.ts";
import { usageItemView } from "../../src/operator-api/usage-views.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";

const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
const FAKE_OPERATOR_KEY = "plain-operator-fake-0002-bbbbbbb";
const WORKSPACE_KEY = "plain-workspace-key-0003-cccccccc";
const FAKE_WORKSPACE_KEY = "plain-workspace-fake-0004-dddddd";
const TWO_PROVIDERS = createProviderRegistry([
  openrouterDescriptor,
  createFakeAdapter(),
]);
const DEFAULT_PROVIDER = openrouterDescriptor.id;
const BOTH = [DEFAULT_PROVIDER, FAKE_PROVIDER_ID];
const BOTH_QUERY = BOTH.join(",");
const DYNAMIC_CLAIM = {
  engines: ["opencode"],
  features: ["dynamic_capabilities"],
  llmProviders: BOTH,
};

function entitlements(
  keyMode: "own" | "managed",
  extra: Partial<EntitlementsData> = {},
): EntitlementsData {
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
    ...extra,
  };
}

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

/** A provider whose metadata answers per model; the models asked about, with the options, are recorded. */
function metadata(answer: (model: string) => ModelCapabilityResult) {
  const asked: Array<{ model: string; options: unknown }> = [];
  const checker: ModelCapabilityChecker = {
    check: async (model, options) => {
      asked.push({ model, options });
      return answer(model);
    },
  };
  return { asked, checker };
}

type Options = {
  /** `null`: the workspace has no entitlements at all (unlimited). */
  keyMode: "own" | "managed" | null;
  dynamic?: boolean;
  /** The settings the project saves, on top of its kind. */
  project?: Record<string, unknown>;
  /** The workspace defaults. */
  defaults?: Record<string, unknown>;
  entitlements?: Partial<EntitlementsData>;
  /**
   * Called after the workspace and the operator hold their keys and before the project is configured. What it returns is
   * saved as settings of the project, so a test can make an entry and select it.
   */
  prepare?: (h: RunnerApiHarness) => Promise<Record<string, unknown> | void>;
  harness?: Parameters<typeof startRunnerApiHarness>[0];
};

/** A workspace with an active project, a queued job and keys for both providers of the registry. */
async function start({
  keyMode,
  dynamic = false,
  project = {},
  defaults,
  entitlements: extra = {},
  prepare,
  harness = {},
}: Options): Promise<RunnerApiHarness> {
  const h = await startRunnerApiHarness({
    llmKey: WORKSPACE_KEY,
    projects: true,
    providers: TWO_PROVIDERS,
    env: { LLM_MODEL: "vendor/instance-model", LLM_MAX_TOKENS: "64000" },
    ...harness,
  });
  await h.setLlmKey(FAKE_WORKSPACE_KEY, FAKE_PROVIDER_ID);
  for (const [provider, apiKey] of [
    [DEFAULT_PROVIDER, OPERATOR_KEY],
    [FAKE_PROVIDER_ID, FAKE_OPERATOR_KEY],
  ] as const) {
    const saved = await h.llm.operatorKey().save({ provider, apiKey }, null);
    expect(saved.ok).toBe(true);
  }
  const prepared = (await prepare?.(h)) ?? {};
  if (keyMode !== null)
    await createWorkspaceEntitlementsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).put(entitlements(keyMode, extra), null);
  await h.projectService.activateProject(h.repositoryId);
  if (defaults !== undefined)
    await h.reviewSettings.updateGlobalSettings(defaults, "operator");
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    ...project,
    ...prepared,
    ...(dynamic ? { reviewKind: "dynamic" as const } : {}),
  });
  await h.enqueueNew();
  return h;
}

/** Writes the settings of the project as they are stored, without the checks of a save (an older release, a restore). */
async function storeRaw(h: RunnerApiHarness, settings: ProjectSettings) {
  await createProjectsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).updateSettings(h.repositoryId, settings);
}

async function recordOf(h: RunnerApiHarness, jobId: string) {
  return createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now).get(
    jobId,
  );
}

async function putEntitlements(
  h: RunnerApiHarness,
  keyMode: "own" | "managed",
  extra: Partial<EntitlementsData> = {},
) {
  await createWorkspaceEntitlementsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).put(entitlements(keyMode, extra), null);
}

describe("an own key: the provider and model of the project, with the key of that provider", () => {
  // #432-T01
  it("sends the key of the selected provider for a Diff job, on the legacy claim and on the Worker's fetch", async () => {
    const claimed = await start({
      keyMode: "own",
      project: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
    });
    const { job } = await claimed.claimed({ llmProviders: BOTH });
    const fetched = await start({
      keyMode: "own",
      project: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
    });

    const { details } = await fetched.startedWorker(undefined, BOTH_QUERY);

    for (const input of [job.input, details.job.input])
      expect(input.llm).toMatchObject({
        provider: FAKE_PROVIDER_ID,
        model: "fake-large",
        apiKey: FAKE_WORKSPACE_KEY,
      });
    expect(JSON.stringify(job.input)).not.toContain(WORKSPACE_KEY);
    expect(await recordOf(claimed, job.id)).toMatchObject({
      keyMode: "own",
      llmProvider: FAKE_PROVIDER_ID,
      catalogEntryId: null,
    });
  });

  // #432-T01
  it("sends the key of the Dynamic provider for a Dynamic job", async () => {
    const h = await start({
      keyMode: "own",
      dynamic: true,
      project: {
        dynamicProvider: FAKE_PROVIDER_ID,
        dynamicModel: "fake-large",
      },
    });

    const { job } = await h.claimed(DYNAMIC_CLAIM);

    expect(job.input).toMatchObject({
      llm: {
        provider: FAKE_PROVIDER_ID,
        model: "fake-large",
        apiKey: FAKE_WORKSPACE_KEY,
      },
      dynamic: { model: "fake-large" },
    });
  });

  // #432-T01
  it("is unchanged for a workspace that never chose a provider: the default provider, the project's model and its key", async () => {
    const h = await start({
      keyMode: "own",
      project: { model: "vendor/project-model", maxTokens: 50_000 },
    });

    const { job } = await h.claimed();

    expect(job.input.llm).toStrictEqual({
      provider: DEFAULT_PROVIDER,
      model: "vendor/project-model",
      apiKey: WORKSPACE_KEY,
      maxTokens: 50_000,
    });
  });

  // #432-T02
  it("fails with llm_not_configured (no_key) when the selected provider has no key, and never uses another provider's key", async () => {
    const h = await start({
      keyMode: "own",
      project: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      prepare: (app) => app.setLlmKey(null, FAKE_PROVIDER_ID),
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim({ llmProviders: BOTH })).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    const written = h.logLines().join("\n");
    expect(written).toContain("no_key");
    expect(written).not.toContain(WORKSPACE_KEY);
    expect(h.issuedJobTokens()).toEqual([]);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
  });

  // #432-T06
  it("reads no catalog row, on the claim and on the fetch", async () => {
    const h = await start({ keyMode: "own" });
    await h.claimed();
    await h.enqueueNew({ prNumber: 8 });

    await h.startedWorker();

    expect(h.catalogReads.count).toBe(0);
  });

  // #432-T16
  it.each([
    ["an empty list", { catalogEntries: [] }],
    ["a list that names an entry", { catalogEntries: ["mce_listed"] }],
    ["every entry", { catalogEntries: null }],
  ])(
    "runs on the selected provider's own key and does not evaluate modelAccess: %s",
    async (_name, modelAccess) => {
      const h = await start({
        keyMode: "own",
        entitlements: { modelAccess },
        project: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      });

      const { job } = await h.claimed({ llmProviders: BOTH });

      expect(job.input.llm).toMatchObject({
        provider: FAKE_PROVIDER_ID,
        apiKey: FAKE_WORKSPACE_KEY,
      });
      expect(h.catalogReads.count).toBe(0);
    },
  );

  // #432-T11
  it("keeps the own settings across a trip to the operator's key and back", async () => {
    const h = await start({
      keyMode: "own",
      project: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
    });
    await putEntitlements(h, "managed");
    expect(
      (await h.claimed({ llmProviders: BOTH })).job.input.llm,
    ).toMatchObject({ apiKey: OPERATOR_KEY, model: "entry/default-model" });
    await putEntitlements(h, "own");
    await h.enqueueNew({ prNumber: 8 });

    const { job } = await h.claimed({ llmProviders: BOTH });

    expect(job.input.llm).toMatchObject({
      provider: FAKE_PROVIDER_ID,
      model: "fake-large",
      apiKey: FAKE_WORKSPACE_KEY,
    });
  });
});

describe("the operator's key: the catalog entry of the project", () => {
  // #432-T03
  it("runs on the entry's model and the operator's key of the entry's provider, on both delivery paths", async () => {
    const options: Options = {
      keyMode: "managed",
      prepare: async (h) => ({
        catalogEntryDiff: (
          await h.catalogEntryFor(FAKE_PROVIDER_ID, {
            name: "Thorough",
            modelId: "fake-thorough",
          })
        ).id,
      }),
    };
    const claimed = await start(options);
    const { job } = await claimed.claimed({ llmProviders: BOTH });
    const fetched = await start(options);

    const { details } = await fetched.startedWorker(undefined, BOTH_QUERY);

    for (const input of [job.input, details.job.input])
      expect(input.llm).toMatchObject({
        provider: FAKE_PROVIDER_ID,
        model: "fake-thorough",
        apiKey: FAKE_OPERATOR_KEY,
      });
    expect(JSON.stringify(job.input)).not.toContain(WORKSPACE_KEY);
    expect(await recordOf(claimed, job.id)).toMatchObject({
      keyMode: "managed",
      catalogEntryName: "Thorough",
      llmProvider: FAKE_PROVIDER_ID,
    });
  });

  // #432-T03
  it("runs on the instance default entry of the kind when the project selects none, for Dynamic too", async () => {
    const h = await start({ keyMode: "managed", dynamic: true });

    const { job } = await h.claimed(DYNAMIC_CLAIM);

    expect(job.input).toMatchObject({
      llm: { model: "entry/default-model", apiKey: OPERATOR_KEY },
      dynamic: { model: "entry/default-model" },
    });
    expect(await recordOf(h, job.id)).toMatchObject({
      catalogEntryId: h.defaultEntry!.id,
      catalogEntryName: "Standard",
    });
  });

  // #432-T03
  it("ignores whatever model the workspace's settings name, which stay stored", async () => {
    const h = await start({
      keyMode: "own",
      project: {
        model: "vendor/project-model",
        dynamicModel: "vendor/dynamic-model",
      },
    });
    await putEntitlements(h, "managed");

    const { job } = await h.claimed();

    const text = JSON.stringify(job.input);
    expect(job.input.llm.model).toBe("entry/default-model");
    for (const named of ["vendor/project-model", "vendor/dynamic-model"])
      expect(text).not.toContain(named);
    expect(
      (await h.reviewSettings.resolveForRepository(h.repositoryId))?.settings,
    ).toMatchObject({ model: "vendor/project-model" });
  });

  it("follows a change of the entry's model at the next claim, with nobody choosing again", async () => {
    const h = await start({ keyMode: "managed" });
    const updated = await h.catalogFixture.service.update(
      h.defaultEntry!.id,
      { modelId: "entry/default-model-v2" },
      null,
    );
    expect(updated.ok).toBe(true);

    const { job } = await h.claimed();

    expect(job.input.llm.model).toBe("entry/default-model-v2");
  });

  // #432-T04
  it.each<[string, (h: RunnerApiHarness, entryId: string) => Promise<void>]>([
    [
      "a retired entry",
      async (h, id) => {
        await h.setCatalogDefaults({ diff: null, dynamic: null });
        const retired = await h.catalogFixture.service.retire(id, null);
        expect(retired.ok).toBe(true);
      },
    ],
    [
      "an entry the plan no longer allows",
      async (h) => {
        await putEntitlements(h, "managed", {
          modelAccess: { catalogEntries: [] },
        });
      },
    ],
    [
      "an entry that does not exist",
      async (h) => {
        await storeRaw(h, { catalogEntryDiff: "mce_vanished" });
      },
    ],
    [
      "an entry that serves only the other kind",
      async (h, id) => {
        await h.setCatalogDefaults({ diff: null, dynamic: null });
        const narrowed = await h.catalogFixture.service.update(
          id,
          { kinds: ["dynamic"] },
          null,
        );
        expect(narrowed.ok).toBe(true);
      },
    ],
  ])(
    "ends the job with managed_model_unavailable and creates no key and no token for %s",
    async (_name, spoil) => {
      const h = await start({ keyMode: "managed" });
      const entry = await h.catalogFixture.entry({ name: "Chosen" });
      await h.reviewSettings.updateProjectSettings(h.repositoryId, {
        catalogEntryDiff: entry.id,
      });
      await spoil(h, entry.id);
      const [job] = await h.snapshotJobs();

      const response = await h.claim();

      expect(response.status).toBe(204);
      expect(await h.queue.get(job!.id)).toMatchObject({
        status: "failed",
        errorCode: "managed_model_unavailable",
      });
      expect(h.issuedJobTokens()).toEqual([]);
      expect(
        await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
      ).toEqual([]);
      expect(await recordOf(h, job!.id)).toMatchObject({ state: "void" });
      const written = h.logLines().join("\n");
      expect(written).toContain("managed_model_unavailable");
      for (const hidden of ["entry/default-model", OPERATOR_KEY, "sentinel/"])
        expect(written).not.toContain(hidden);
    },
  );

  // #432-T04
  it("ends the job when neither the project nor the instance names an entry, and never uses the instance's model", async () => {
    const h = await start({
      keyMode: "managed",
      harness: { defaultEntry: false },
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim()).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "managed_model_unavailable",
    });
    expect(h.logLines().join("\n")).toContain("no_selection");
    expect(h.logLines().join("\n")).not.toContain("vendor/instance-model");
  });

  // #432-T15
  it("names not_allowed in the log when the plan's modelAccess does not contain the entry, and sends nothing", async () => {
    const h = await start({
      keyMode: "managed",
      entitlements: { modelAccess: { catalogEntries: ["mce_other"] } },
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim()).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "managed_model_unavailable",
    });
    expect(h.logLines().join("\n")).toContain("not_allowed");
  });

  // #432-T04
  it("ends a Dispatcher's job at its claim, and the Worker's fetch ends it when the entry went away since", async () => {
    const dispatcher = await start({
      keyMode: "managed",
      harness: { defaultEntry: false },
    });
    expect((await dispatcher.claimSplit()).status).toBe(204);

    const h = await start({ keyMode: "managed" });
    const claim = await h.claimedSplit();
    // The Dispatcher's claim passed; the operator retires the entry before the Worker fetches the job.
    await h.setCatalogDefaults({ diff: null, dynamic: null });
    await h.catalogFixture.service.retire(h.defaultEntry!.id, null);

    const response = await h.worker.details(claim.job.id, claim.job.credential);
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(text).not.toContain(OPERATOR_KEY);
    expect(await h.queue.get(claim.job.id)).toMatchObject({
      status: "failed",
      errorCode: "managed_model_unavailable",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #432-T07
  it("records the entry, its name and the key mode of a managed run, and the operator feed shows the entry and no model", async () => {
    const h = await start({ keyMode: "managed" });
    const { job } = await h.claimed();
    await h.complete(job.id, job.leaseToken, {});

    const record = await recordOf(h, job.id);

    expect(record).toMatchObject({
      keyMode: "managed",
      state: "settled",
      catalogEntryId: h.defaultEntry!.id,
      catalogEntryName: "Standard",
      modelTier: null,
    });
    const view = usageItemView(record!);
    expect(view).toMatchObject({
      catalogEntryId: h.defaultEntry!.id,
      catalogEntryName: "Standard",
      modelTier: null,
    });
    expect(JSON.stringify(view)).not.toContain("entry/default-model");
  });

  // #432-T07
  it("keeps the name of the entry as it was at the claim when the entry is renamed later", async () => {
    const h = await start({ keyMode: "managed" });
    const { job } = await h.claimed();
    await h.catalogFixture.service.update(
      h.defaultEntry!.id,
      { name: "Renamed" },
      null,
    );
    await h.complete(job.id, job.leaseToken, {});

    expect(await recordOf(h, job.id)).toMatchObject({
      catalogEntryName: "Standard",
    });
  });

  // #432-T07
  it("logs the entry and the kind of the claim, and neither the model nor a key", async () => {
    const h = await start({ keyMode: "managed" });

    await h.claimed();

    const written = h.logLines().join("\n");
    expect(written).toContain(`entry=${h.defaultEntry!.id} kind=diff`);
    for (const hidden of ["entry/default-model", OPERATOR_KEY])
      expect(written).not.toContain(hidden);
  });
});

describe("the model of an entry stays on the server", () => {
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

  // #432-T08
  it("reports no model in the stored result and masks the ids of this entry, of other entries and of retired ones", async () => {
    const h = await start({ keyMode: "managed" });
    const other = await h.catalogFixture.entry({
      name: "Other",
      modelId: "other-vendor/other-model",
    });
    const retired = await h.catalogFixture.entry({
      name: "Gone",
      modelId: "gone-vendor/retired-model",
      status: "retired",
    });
    const { job } = await h.claimed();

    await h.complete(job.id, job.leaseToken, {
      logTail: [
        "using entry/default-model",
        `also ${other.modelId} and ${retired.modelId}`,
      ].join("\n"),
      errorMessage: "429 from the provider for entry/default-model",
      usage: usageOf("openrouter/entry/default-model"),
    });

    const stored = JSON.stringify((await h.queue.get(job.id))?.result);
    for (const model of ["entry/default-model", other.modelId, retired.modelId])
      expect(stored).not.toContain(model);
    expect(stored).toContain("[model]");
    expect(JSON.parse(stored).usage).toMatchObject({
      model: null,
      promptTokens: 10,
      costUsd: 0.01,
    });
  });

  // #432-T08
  it("masks the model the job was handed even when the operator changed the entry since, on another app instance", async () => {
    const h = await start({ keyMode: "managed" });
    const { job } = await h.claimed();
    await h.catalogFixture.service.update(
      h.defaultEntry!.id,
      { modelId: "entry/default-model-v2" },
      null,
    );

    await h.anotherInstance().complete(job.id, job.leaseToken, {
      logTail: "handed entry/default-model, now entry/default-model-v2",
    });

    const stored = JSON.stringify((await h.queue.get(job.id))?.result);
    expect(stored).not.toContain("entry/default-model");
  });

  // #432-T08
  it("is not in a log line, a job row, a usage record or a key row", async () => {
    const h = await start({ keyMode: "managed" });
    const { job } = await h.claimed();
    await h.complete(job.id, job.leaseToken, {
      logTail: "calling entry/default-model",
    });

    const everything = [
      ...h.logLines(),
      JSON.stringify(await h.snapshotJobs()),
      JSON.stringify(
        await h.db.selectFrom("usage_records").selectAll().execute(),
      ),
    ].join("\n");
    expect(everything).not.toContain("entry/default-model");
  });

  // #432-T08
  it("still hides the model when the sealed row of the job cannot be read", async () => {
    const h = await start({ keyMode: "managed" });
    const { job } = await h.claimed();
    await h.db.updateTable("job_claimed_keys").set({ nonce: "AAAA" }).execute();
    expect(await h.claimedKeys.modelsOf(job.id)).toEqual([]);

    await h.complete(job.id, job.leaseToken, {
      logTail: "model entry/default-model answered",
      usage: usageOf("openrouter/entry/default-model"),
    });

    const stored = JSON.stringify((await h.queue.get(job.id))?.result);
    expect(stored).not.toContain("entry/default-model");
    expect(JSON.parse(stored).usage.model).toBeNull();
    expect(stored).toContain("[model] answered");
  });

  // #432-T08
  it("keeps reporting the model of a run on the workspace's own key, even when it is the model of an entry", async () => {
    const h = await start({
      keyMode: "own",
      project: { model: "entry/default-model" },
    });
    expect(h.defaultEntry?.modelId).toBe("entry/default-model");
    const { job } = await h.claimed();

    await h.complete(job.id, job.leaseToken, {
      logTail: "model entry/default-model answered",
      usage: usageOf("openrouter/entry/default-model"),
    });

    const stored = (await h.queue.get(job.id))?.result as {
      logTail: string;
      usage: { model: string };
    };
    expect(stored.usage.model).toBe("openrouter/entry/default-model");
    expect(stored.logTail).toBe("model entry/default-model answered");
    expect(await h.claimedKeys.modelsOf(job.id)).toEqual([]);
  });
});

describe("a managed Dynamic job whose entry's model cannot be used", () => {
  // #432-T03
  it("ends dynamic_model_features_unsupported when the model of the entry lacks tool calling, and hands out nothing", async () => {
    const meta = metadata(() => ({
      outcome: "unsupported",
      capabilities: { ...supported().capabilities!, tools: false },
    }));
    const h = await start({
      keyMode: "managed",
      dynamic: true,
      harness: { modelCapabilities: meta.checker },
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim(DYNAMIC_CLAIM)).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_model_features_unsupported",
    });
    expect(meta.asked).toEqual([
      {
        model: "entry/default-model",
        options: expect.objectContaining({ provider: DEFAULT_PROVIDER }),
      },
    ]);
    expect(h.issuedJobTokens()).toEqual([]);
  });
});

describe("the token budget of a job on the operator's key", () => {
  // #432-T09
  it("is cut to the documented bound when the window of the entry's model is not known", async () => {
    const h = await start({
      keyMode: "managed",
      project: { maxTokens: 150_000 },
    });

    expect((await h.claimed()).job.input.llm.maxTokens).toBe(
      UNKNOWN_WINDOW_MAX_TOKENS,
    );
  });

  // #432-T09
  it("is clamped to the context window of the entry's model, read as a claim and logged by the entry, not the model", async () => {
    const meta = metadata(() => supported(64_000));
    const h = await start({
      keyMode: "managed",
      project: { maxTokens: 150_000 },
      harness: { modelCapabilities: meta.checker },
    });

    const { job } = await h.claimed();

    expect(job.input.llm.maxTokens).toBe(64_000);
    expect(meta.asked).toEqual([
      {
        model: "entry/default-model",
        options: {
          forClaim: true,
          logAs: `entry=${h.defaultEntry!.id}`,
          provider: DEFAULT_PROVIDER,
        },
      },
    ]);
  });

  // #432-T09
  it("uses the last window read for the entry's model of that provider when the provider cannot be asked now", async () => {
    let answer: ModelCapabilityResult = supported(64_000);
    const known = new Map<string, number>();
    const lookups: Array<[string, string | undefined]> = [];
    const checker: ModelCapabilityChecker = {
      check: async (model, options) => {
        if (answer.outcome === "supported")
          known.set(`${options?.provider}/${model}`, 64_000);
        return answer;
      },
      lastKnownContextLength: (model, provider) => {
        lookups.push([model, provider]);
        return known.get(`${provider}/${model}`) ?? null;
      },
    };
    const h = await start({
      keyMode: "managed",
      project: { maxTokens: 150_000 },
      harness: { modelCapabilities: checker },
    });
    expect((await h.claimed()).job.input.llm.maxTokens).toBe(64_000);
    answer = { outcome: "unverifiable" };
    await h.enqueueNew({ prNumber: 8 });

    expect((await h.claimed()).job.input.llm.maxTokens).toBe(64_000);
    expect(lookups).toEqual([["entry/default-model", DEFAULT_PROVIDER]]);
  });

  // #432-T09
  it("is cut to the bound when the provider cannot be asked and no window was ever read for the entry's model", async () => {
    const checker: ModelCapabilityChecker = {
      check: async () => ({ outcome: "unverifiable" }),
      lastKnownContextLength: () => null,
    };
    const h = await start({
      keyMode: "managed",
      project: { maxTokens: 150_000 },
      harness: { modelCapabilities: checker },
    });

    expect((await h.claimed()).job.input.llm.maxTokens).toBe(
      UNKNOWN_WINDOW_MAX_TOKENS,
    );
  });

  // #432-T09
  it("is clamped to the Dynamic entry's window with one read of its metadata", async () => {
    const meta = metadata(() => supported(100_000));
    const h = await start({
      keyMode: "managed",
      dynamic: true,
      project: { maxTokens: 150_000 },
      harness: { modelCapabilities: meta.checker },
    });

    const { job } = await h.claimed(DYNAMIC_CLAIM);

    expect(job.input.llm.maxTokens).toBe(100_000);
    expect(meta.asked).toHaveLength(1);
  });

  // #432-T09
  it("is not clamped for a workspace on its own key, and the provider is not asked for a Diff model", async () => {
    const meta = metadata(() => supported(8_000));
    const h = await start({
      keyMode: "own",
      project: { maxTokens: 150_000, model: "vendor/own-model" },
      harness: { modelCapabilities: meta.checker },
    });

    expect((await h.claimed()).job.input.llm.maxTokens).toBe(150_000);
    expect(meta.asked).toEqual([]);
  });
});

describe("admission comes before any selection work", () => {
  // #432-T10
  it("ends a job of a suspended workspace with workspace_suspended and reads neither the catalog nor a key", async () => {
    const h = await start({
      keyMode: "managed",
      entitlements: { suspended: true, suspensionCode: "operator_hold" },
      harness: { defaultEntry: false },
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim()).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "workspace_suspended",
    });
    expect(h.catalogReads.count).toBe(0);
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #432-T10
  it("ends a job over the run limit with quota_exhausted before an entry is looked at", async () => {
    const h = await start({
      keyMode: "managed",
      entitlements: {
        limits: {
          diffRunsPerPeriod: 0,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
      },
      harness: { defaultEntry: false },
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim()).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
    expect(h.catalogReads.count).toBe(0);
  });
});

describe("the legacy claim and the Worker's fetch cannot disagree", () => {
  // #432-T12
  it("re-checks the standing at the fetch: a workspace suspended since the claim gets no key", async () => {
    const h = await start({ keyMode: "managed" });
    const claim = await h.claimedSplit();
    await putEntitlements(h, "managed", {
      suspended: true,
      suspensionCode: "operator_hold",
    });

    const response = await h.worker.details(claim.job.id, claim.job.credential);

    expect(response.status).toBe(409);
    expect(await h.queue.get(claim.job.id)).toMatchObject({
      errorCode: "workspace_suspended",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #432-T12
  it("selects again at the fetch: a workspace that moved from the own key to the operator's key is served the entry", async () => {
    const h = await start({
      keyMode: "own",
      project: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
    });
    const claim = await h.claimedSplit();
    await putEntitlements(h, "managed");

    const response = await h.worker.details(
      claim.job.id,
      claim.job.credential,
      undefined,
      undefined,
      BOTH_QUERY,
    );
    const details = await response.json();

    expect(details.job.input.llm).toMatchObject({
      model: "entry/default-model",
      apiKey: OPERATOR_KEY,
    });
  });

  // #432-T25
  it.each<[string, Options]>([
    [
      "an own job on a second provider",
      {
        keyMode: "own",
        project: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      },
    ],
    ["an own job on the default provider", { keyMode: "own" }],
    ["a managed job on the default entry", { keyMode: "managed" }],
    ["a workspace without entitlements", { keyMode: null }],
  ])(
    "hands out the same llm input on both paths: %s",
    async (_name, options) => {
      const claimed = await start(options);
      const { job } = await claimed.claimed({ llmProviders: BOTH });
      const fetched = await start(options);

      const { details } = await fetched.startedWorker(undefined, BOTH_QUERY);

      expect(details.job.input.llm).toEqual(job.input.llm);
    },
  );
});

describe("the llmProviders gate", () => {
  const OWN_SECOND = {
    keyMode: "own",
    project: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
  } as const;

  // #432-T05
  it("ends an own job with llm_provider_unsupported when the runner advertised no providers", async () => {
    const h = await start(OWN_SECOND);
    const [job] = await h.snapshotJobs();

    expect((await h.claim()).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_provider_unsupported",
    });
    expect(h.issuedJobTokens()).toEqual([]);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
    expect(h.logLines().join("\n")).not.toContain(FAKE_WORKSPACE_KEY);
  });

  // #432-T05
  it("ends an own job when the runner advertised other providers only, and hands it out to a runner that listed the provider", async () => {
    const refused = await start(OWN_SECOND);
    expect(
      (await refused.claim({ llmProviders: [DEFAULT_PROVIDER] })).status,
    ).toBe(204);
    const served = await start(OWN_SECOND);

    const { job } = await served.claimed({ llmProviders: BOTH });

    expect(job.input.llm.provider).toBe(FAKE_PROVIDER_ID);
  });

  // #432-T05
  it("ends a managed job whose entry is of a provider the runner did not advertise, with no model named", async () => {
    const h = await start({ keyMode: "managed" });
    const entry = await h.catalogEntryFor(FAKE_PROVIDER_ID, {
      name: "Elsewhere",
      modelId: "fake-elsewhere",
    });
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      catalogEntryDiff: entry.id,
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim({ llmProviders: [DEFAULT_PROVIDER] })).status).toBe(
      204,
    );

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "managed_model_unavailable",
    });
    expect(h.logLines().join("\n")).toContain("provider_unsupported");
    expect(h.logLines().join("\n")).not.toContain("fake-elsewhere");
  });

  // #432-T26
  it("takes the list of a Worker from its details call, not from the Dispatcher's claim", async () => {
    const lacking = await start(OWN_SECOND);
    // A Dispatcher sends no list; the claim cannot judge and the job is handed on.
    const claim = await lacking.claimedSplit();
    const refused = await lacking.worker.details(
      claim.job.id,
      claim.job.credential,
      undefined,
      undefined,
      DEFAULT_PROVIDER,
    );
    expect(refused.status).toBe(409);
    expect(await lacking.queue.get(claim.job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_provider_unsupported",
    });
    expect(lacking.issuedJobTokens()).toEqual([]);

    const served = await start(OWN_SECOND);
    const second = await served.claimedSplit();
    const handed = await served.worker.details(
      second.job.id,
      second.job.credential,
      undefined,
      undefined,
      BOTH_QUERY,
    );

    expect(handed.status).toBe(200);
    expect((await handed.json()).job.input.llm).toMatchObject({
      provider: FAKE_PROVIDER_ID,
      apiKey: FAKE_WORKSPACE_KEY,
    });
  });

  // #432-T26
  it("reads a Worker that names no providers as a runner of the default provider only", async () => {
    const h = await start(OWN_SECOND);
    const claim = await h.claimedSplit();

    const response = await h.worker.details(claim.job.id, claim.job.credential);

    expect(response.status).toBe(409);
    expect(await h.queue.get(claim.job.id)).toMatchObject({
      errorCode: "llm_provider_unsupported",
    });
  });

  // #432-T26
  it("hands the default provider to a Worker that names none, unchanged", async () => {
    const h = await start({ keyMode: "own" });

    const { details } = await h.startedWorker();

    expect(details.job.input.llm).toMatchObject({
      provider: DEFAULT_PROVIDER,
      apiKey: WORKSPACE_KEY,
    });
  });
});

/** Settings layers that reach the resolver as they are, whatever a stored value would have been read as. */
function layersOf(
  project: { provider?: string; model?: string },
  workspace?: { provider?: string; model?: string },
): NonNullable<Options["harness"]> {
  return {
    jobOptions: {
      optionsFor: async () => ({
        env: {},
        selection: {
          layers: {
            project,
            ...(workspace === undefined ? {} : { workspace }),
          },
          entryId: null,
        },
      }),
    },
  };
}

describe("the provider the tenant wrote", () => {
  const EVIL = `bad\n\u001b[31mred${"x".repeat(10_000)}`;

  // #432-T21
  it("is bounded and made printable before it is logged, and no raw control character reaches the log or a job row", async () => {
    const h = await start({
      keyMode: "own",
      harness: layersOf({ provider: EVIL, model: "vendor/m" }),
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim({ llmProviders: BOTH })).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_provider_unsupported",
    });
    const line = h
      .logLines()
      .find((candidate) => candidate.includes("llm_provider_unsupported"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(line).not.toContain(EVIL);
    expect(line).toContain("...");
    expect(line!.length).toBeLessThan(MAX_PROVIDER_TEXT_CHARS + 200);
    expect(JSON.stringify(await h.snapshotJobs())).not.toContain(
      "x".repeat(100),
    );
  });
});

describe("a model that does not belong to the provider that applies", () => {
  // #432-T22
  it("fails closed with job_llm_options_invalid for a workspace model next to a project provider of another provider", async () => {
    const h = await start({ keyMode: "own" });
    // The pairing is stored by an earlier release, which did not check it at the save.
    await createAppSettingsRepository(h.db, h.workspaceId).set(
      REVIEW_DEFAULTS_KEY,
      { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      "operator",
    );
    await storeRaw(h, { provider: DEFAULT_PROVIDER });
    const [job] = await h.snapshotJobs();

    expect((await h.claim({ llmProviders: BOTH })).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "job_llm_options_invalid",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #432-T22
  it("checks a model against the model-id rule of the provider that applies, not the default provider's", async () => {
    const h = await start({
      keyMode: "own",
      // Valid for the default provider (vendor/name), not for the second one.
      harness: layersOf({
        provider: FAKE_PROVIDER_ID,
        model: "Vendor/Not_Fake",
      }),
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim({ llmProviders: BOTH })).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "job_llm_options_invalid",
    });
    expect(h.logLines().join("\n")).toContain("model_invalid");
  });
});

describe("the key is loaded after the selection", () => {
  // #432-T23
  it.each<[string, Options, Parameters<RunnerApiHarness["claim"]>[0]]>([
    [
      "a managed job without a usable entry",
      { keyMode: "managed", harness: { defaultEntry: false } },
      undefined,
    ],
    [
      "an own job whose provider the runner cannot run",
      {
        keyMode: "own",
        project: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      },
      undefined,
    ],
  ])("loads no key for %s", async (_name, options, request) => {
    const loaded: string[] = [];
    const h = await start({
      ...options,
      harness: {
        ...options.harness,
        loadLlm: async (workspaceId) => {
          loaded.push(workspaceId);
          throw new Error("a key was loaded");
        },
      },
    });

    expect((await h.claim(request)).status).toBe(204);

    expect(loaded).toEqual([]);
  });
});

describe("a managed job that fails after the selection", () => {
  // #432-T03
  it("is handed no key of the workspace and ends llm_not_configured when the operator holds no key for the entry's provider", async () => {
    const h = await start({
      keyMode: "managed",
      prepare: async (app) => {
        await app.llm.operatorKey().remove(DEFAULT_PROVIDER);
      },
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claim()).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.logLines().join("\n")).toContain("operator_key_missing");
    expect(h.logLines().join("\n")).not.toContain(WORKSPACE_KEY);
  });
});
