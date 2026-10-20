// SPDX-License-Identifier: Apache-2.0

// The cost policy of a native job at claim time (#553), on both ways a job reaches a runner: the legacy claim and the Worker
// API's first fetch (the Dispatcher's claim runs the checks too, before any VM starts).
//
// A job is native when its selection names a catalog model (`ClaimDeps.nativeCost.refOf`); the running server maps no
// selection to one yet (the registry knows only the legacy providers, see src/native-cost/README.md), so the tests make the
// harness's second provider native. The managed key (we pay) is refused before any key or token exists unless the model is
// enabled and has a confirmed price; the confirmed book travels in the claim and is the runner's only price source. The own
// key (the user pays the provider) is never refused for a price and travels with the token cap of the instance.
import { describe, expect, it } from "vitest";
import {
  createFakeAdapter,
  FAKE_PROVIDER_ID,
} from "../../src/llm/providers/fake-adapter.ts";
import { openrouterDescriptor } from "../../src/llm/providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "../../src/llm/providers/registry.ts";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import type { ManagedAvailabilityJson } from "../../src/model-prices/availability.ts";
import type { PriceBookJson } from "../../src/model-prices/price-book.ts";
import type { ModelCapabilityChecker } from "../../src/llm/model-capabilities.ts";
import type { JobModelEntry } from "../../src/models-dev/job-entry.ts";
import {
  createNativeCostService,
  type EntryOutcome,
} from "../../src/native-cost/service.ts";
import {
  goodResult,
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";

const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
const FAKE_OPERATOR_KEY = "plain-operator-fake-0002-bbbbbbb";
const WORKSPACE_KEY = "plain-workspace-key-0003-cccccccc";
const FAKE_WORKSPACE_KEY = "plain-workspace-fake-0004-dddddd";
const PROVIDERS = createProviderRegistry([
  openrouterDescriptor,
  createFakeAdapter(),
]);
const BOTH = [openrouterDescriptor.id, FAKE_PROVIDER_ID];
const NATIVE_MODEL = "fake-thorough";
const BOOK: PriceBookJson = {
  input: "660000",
  output: "1980000",
  cacheRead: "22000",
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: null,
  inputAudio: null,
  outputAudio: null,
  contextOver200k: null,
  tiers: [],
};
// What the catalog tells a job about its model (#578); the harness's native provider is not a provider of the catalog, so
// the service that would read the entry is replaced by this one.
const ENTRY: JobModelEntry = {
  version: 1,
  providerId: "deepseek",
  npm: "@ai-sdk/openai-compatible",
  family: "openai-chat",
  authHeader: "Authorization",
  upstreamBaseUrl: "https://api.deepseek.com",
  modelId: NATIVE_MODEL,
  model: {
    name: "Thorough",
    status: "active",
    tool_call: true,
    reasoning: false,
    temperature: true,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ["text"], output: ["text"] },
  },
};
const CLAIM = {
  engines: ["opencode"],
  features: ["dynamic_capabilities", "dynamic_cost_policy"],
  llmProviders: BOTH,
};
const WORKER_FEATURES = "dynamic_capabilities,dynamic_cost_policy";
// A Dispatcher can be handed a Dynamic job when it names the engine; what its Worker can do is judged at the Worker's fetch.
const DISPATCHER = { engines: ["opencode"], llmProviders: BOTH };

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

/** What the price service answers; counted, so a test can prove it was not asked. */
function scriptedPrices(
  availability: ManagedAvailabilityJson,
  catalogPrice: PriceBookJson | null = BOOK,
) {
  const asked = { availability: 0, catalogPrice: 0 };
  return {
    asked,
    prices: {
      availability: async () => {
        asked.availability += 1;
        return availability;
      },
      catalogPrice: async () => {
        asked.catalogPrice += 1;
        return catalogPrice;
      },
    },
  };
}

const CONFIRMED: ManagedAvailabilityJson = {
  selectable: true,
  book: BOOK,
  confirmationId: 3,
  hashVersion: 2,
};

type Started = RunnerApiHarness & {
  asked: { availability: number; catalogPrice: number };
  /** How often the entry of the model was asked for. */
  entries: { count: number };
  keyLoads: { count: number };
};

async function start(options: {
  keyMode: "own" | "managed";
  dynamic?: boolean;
  availability?: ManagedAvailabilityJson;
  catalogPrice?: PriceBookJson | null;
  /** The provider the project selects; the fake one is the native one. */
  provider?: string;
  /** What the catalog says about the entry of the model (#578). Default: the entry of `ENTRY`. */
  entry?: EntryOutcome;
  /** A reader of the provider's model metadata, to see whether a claim asks it (#578). */
  capabilities?: ModelCapabilityChecker;
  /** The switch of the native path as the server reads it, now: a test turns it off after the claim (#578). */
  live?: { native: boolean };
}): Promise<Started> {
  const live = options.live ?? { native: true };
  const script = scriptedPrices(
    options.availability ?? CONFIRMED,
    options.catalogPrice === undefined ? BOOK : options.catalogPrice,
  );
  const keyLoads = { count: 0 };
  const entries = { count: 0 };
  let settingsDb: ReturnType<typeof createInstanceSettingsRepository> | null =
    null;
  const h = await startRunnerApiHarness({
    llmKey: WORKSPACE_KEY,
    projects: true,
    providers: PROVIDERS,
    ...(options.capabilities === undefined
      ? {}
      : { modelCapabilities: options.capabilities }),
    env: { LLM_MODEL: "vendor/instance-model", LLM_MAX_TOKENS: "64000" },
    nativeCost: {
      ...createNativeCostService({
        prices: script.prices,
        // The harness database is not there yet while its options are built; the settings are read at the claim.
        settings: {
          get: (key) =>
            settingsDb === null
              ? Promise.resolve(undefined)
              : settingsDb.get(key),
        },
        // The entry is replaced below: the harness's provider is not one of the catalog.
        catalog: {
          getProvider: async () => undefined,
          getModel: async () => undefined,
        },
        legacyProviders: [openrouterDescriptor.id],
        registryAddresses: {},
      }),
      entryFor: async () => {
        entries.count += 1;
        return options.entry ?? { ok: true, entry: ENTRY };
      },
      // The harness's second provider is the native one: the real map names no provider outside the legacy registry.
      refOf: (selection) =>
        live.native && selection.provider === FAKE_PROVIDER_ID
          ? { providerId: "deepseek", modelId: selection.model }
          : null,
    },
    loadLlm: undefined,
  });
  settingsDb = createInstanceSettingsRepository(h.db);
  await h.setLlmKey(FAKE_WORKSPACE_KEY, FAKE_PROVIDER_ID);
  for (const [provider, apiKey] of [
    [openrouterDescriptor.id, OPERATOR_KEY],
    [FAKE_PROVIDER_ID, FAKE_OPERATOR_KEY],
  ] as const) {
    const saved = await h.llm.operatorKey().save({ provider, apiKey }, null);
    expect(saved.ok).toBe(true);
  }
  const entry = await h.catalogEntryFor(FAKE_PROVIDER_ID, {
    name: "Thorough",
    modelId: NATIVE_MODEL,
    kinds: ["diff", "dynamic"],
  });
  await createWorkspaceEntitlementsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).put(entitlements(options.keyMode), null);
  await h.projectService.activateProject(h.repositoryId);
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    ...(options.keyMode === "managed"
      ? { catalogEntryDynamic: entry.id, catalogEntryDiff: entry.id }
      : {
          dynamicProvider: options.provider ?? FAKE_PROVIDER_ID,
          dynamicModel: NATIVE_MODEL,
          provider: options.provider ?? FAKE_PROVIDER_ID,
          model: NATIVE_MODEL,
        }),
    ...(options.dynamic === false ? {} : { reviewKind: "dynamic" as const }),
  });
  await h.enqueueNew();
  return Object.assign(h, { asked: script.asked, entries, keyLoads });
}

async function recordOf(h: RunnerApiHarness, jobId: string) {
  return createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now).get(
    jobId,
  );
}

describe("the managed key (we pay)", () => {
  // #553-T01
  it.each<[string, ManagedAvailabilityJson, string]>([
    [
      "a price that is not confirmed",
      {
        selectable: false,
        reason: "price_unconfirmed",
        code: "catalog_price_unconfirmed",
      },
      "catalog_price_unconfirmed",
    ],
    [
      "a model nobody enabled",
      {
        selectable: false,
        reason: "model_not_enabled",
        code: "catalog_model_unavailable",
      },
      "catalog_model_unavailable",
    ],
  ])(
    "ends the job before any key or token exists for %s, and names neither the model nor a price",
    async (_name, availability, code) => {
      const h = await start({ keyMode: "managed", availability });
      const [job] = await h.snapshotJobs();

      const response = await h.claim(CLAIM);

      expect(response.status).toBe(204);
      expect(await h.queue.get(job!.id)).toMatchObject({
        status: "failed",
        errorCode: "managed_model_unavailable",
      });
      expect(h.issuedJobTokens()).toEqual([]);
      expect(
        await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
      ).toEqual([]);
      // No usage record counts: nothing was used.
      expect(await recordOf(h, job!.id)).toMatchObject({ state: "void" });
      const written = h.logLines().join("\n");
      expect(written).toContain("managed_model_unavailable");
      expect(written).toContain(code);
      for (const hidden of [
        NATIVE_MODEL,
        FAKE_PROVIDER_ID,
        "deepseek",
        "660000",
        FAKE_OPERATOR_KEY,
      ])
        expect(written).not.toContain(hidden);
    },
  );

  // #553-T01
  it("gives the job back, and does not end it, when the price check itself failed", async () => {
    const h = await start({
      keyMode: "managed",
      availability: {
        selectable: false,
        reason: "check_failed",
        code: "catalog_model_unavailable",
      },
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(h.logLines().join("\n")).toContain("given back: price_check_failed");
    expect(await h.queue.get(job!.id)).toMatchObject({ status: "queued" });
    // Nothing of the job left: no token, no remembered key.
    expect(h.issuedJobTokens()).toEqual([]);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
  });

  // #553-T01
  it("ends a Dispatcher's job at its claim, before the Worker and the VM exist", async () => {
    const h = await start({
      keyMode: "managed",
      availability: {
        selectable: false,
        reason: "price_unconfirmed",
        code: "catalog_price_unconfirmed",
      },
    });
    const [job] = await h.snapshotJobs();

    expect((await h.claimSplit(DISPATCHER)).status).toBe(204);

    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "managed_model_unavailable",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #553-T02
  it("hands the runner the confirmed book as its only price source, on the claim and on the Worker's fetch", async () => {
    const claimed = await start({ keyMode: "managed" });
    const { job } = await claimed.claimed(CLAIM);
    const fetched = await start({ keyMode: "managed" });

    const { details } = await fetched.startedWorker(
      WORKER_FEATURES,
      BOTH.join(","),
      DISPATCHER,
    );

    for (const input of [job.input, details.job.input])
      expect(input).toMatchObject({
        dynamic: {
          cost: { keyMode: "managed", priceBook: BOOK, maxTotalTokens: null },
        },
      });
    // Which confirmation priced the run is in the log, so a price in dispute can be traced (#577).
    expect(claimed.logLines().join("\n")).toMatch(
      /selection entry=\S+ .*confirmation=3 hash=2/,
    );
    expect(await recordOf(claimed, job.id)).toMatchObject({
      keyMode: "managed",
    });
  });

  // #553-T09, #577-L6
  it("settles a native success without a cost as dynamic_accounting_failed, and the same report twice to one result", async () => {
    const h = await start({ keyMode: "managed" });
    const { job } = await h.claimed(CLAIM);
    const noCost = { ...goodResult().usage!, costUsd: null };

    const done = await h.complete(job.id, job.leaseToken, { usage: noCost });
    const again = await h.complete(job.id, job.leaseToken, { usage: noCost });

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
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyCompleted: true });
  });

  // #578-T30
  it("still holds a native run to its cost when the switch is turned off between the claim and the report", async () => {
    const live = { native: true };
    const h = await start({ keyMode: "managed", live });
    const { job } = await h.claimed(CLAIM);
    live.native = false;
    const noCost = { ...goodResult().usage!, costUsd: null };

    await h.complete(job.id, job.leaseToken, { usage: noCost });

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_accounting_failed",
    });
  });

  // #578-T33
  it("still holds a native run to its cost when the switch is turned off between the Worker's fetch and its report", async () => {
    const live = { native: true };
    const h = await start({ keyMode: "managed", live });
    const { jobId, credential, details } = await h.startedWorker(
      WORKER_FEATURES,
      BOTH.join(","),
      DISPATCHER,
    );
    expect(details.job.input).toMatchObject({ dynamic: { modelEntry: ENTRY } });
    live.native = false;
    const noCost = { ...goodResult().usage!, costUsd: null };

    await h.worker.result(jobId, credential, { usage: noCost });

    expect(await h.queue.get(jobId)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_accounting_failed",
    });
  });

  // #578-T34
  it("does not read a legacy re-claim as native when the switch was turned off after the first, native claim", async () => {
    const live = { native: true };
    const h = await start({ keyMode: "managed", live });
    const first = await h.claimed(CLAIM);
    expect(first.job.input).toMatchObject({ dynamic: { modelEntry: ENTRY } });
    live.native = false;
    h.clock.advance(3 * 60 * 1000);

    const again = await h.claimed({ ...CLAIM, runnerId: "runner-b" });
    expect(again.job.id).toBe(first.job.id);
    expect(again.job.input).not.toHaveProperty("dynamic.modelEntry");
    const noCost = { ...goodResult().usage!, costUsd: null };
    await h.complete(again.job.id, again.job.leaseToken, { usage: noCost });

    expect(await h.queue.get(again.job.id)).toMatchObject({
      status: "succeeded",
    });
  });

  // #578-T34
  it("does not read a second Worker fetch as native when the switch was turned off after the first, native fetch", async () => {
    const live = { native: true };
    const h = await start({ keyMode: "managed", live });
    const { jobId, credential } = await h.startedWorker(
      WORKER_FEATURES,
      BOTH.join(","),
      DISPATCHER,
    );
    live.native = false;
    const again = await h.worker.details(
      jobId,
      credential,
      WORKER_FEATURES,
      undefined,
      BOTH.join(","),
    );
    expect(again.status).toBe(200);
    const noCost = { ...goodResult().usage!, costUsd: null };

    await h.worker.result(jobId, credential, { usage: noCost });

    expect(await h.queue.get(jobId)).toMatchObject({ status: "succeeded" });
  });

  // #577-L6
  it("settles a native success with a known cost as before", async () => {
    const h = await start({ keyMode: "managed" });
    const { job } = await h.claimed(CLAIM);

    await h.complete(job.id, job.leaseToken);

    expect(await h.queue.get(job.id)).toMatchObject({ status: "succeeded" });
  });

  // #553-R09
  it("never hands a cost policy to a runner that did not say it enforces one", async () => {
    const h = await start({ keyMode: "managed" });
    const [job] = await h.snapshotJobs();

    const response = await h.claim({
      engines: ["opencode"],
      features: ["dynamic_capabilities"],
      llmProviders: BOTH,
    });

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_engine_unavailable",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });
});

describe("the own key (the user pays the provider)", () => {
  // #553-T04
  it("is never refused for a price: it carries the catalog's price and the token cap", async () => {
    const h = await start({
      keyMode: "own",
      availability: {
        selectable: false,
        reason: "price_unconfirmed",
        code: "catalog_price_unconfirmed",
      },
    });

    const { job } = await h.claimed(CLAIM);

    expect(job.input).toMatchObject({
      dynamic: {
        cost: { keyMode: "own", priceBook: BOOK, maxTotalTokens: 4_000_000 },
      },
      llm: { provider: FAKE_PROVIDER_ID, apiKey: FAKE_WORKSPACE_KEY },
    });
    // The managed check is not asked for an own key.
    expect(h.asked.availability).toBe(0);
  });

  // #553-T05
  it("carries no book and the cap for a model nobody priced", async () => {
    const h = await start({ keyMode: "own", catalogPrice: null });

    const { job } = await h.claimed(CLAIM);

    expect(job.input).toMatchObject({
      dynamic: {
        cost: { keyMode: "own", priceBook: null, maxTotalTokens: 4_000_000 },
      },
    });
  });

  // #553-T11
  it("carries the cap the admin set, from the next claim on", async () => {
    const h = await start({ keyMode: "own" });
    const first = await h.claimed(CLAIM);
    await createInstanceSettingsRepository(h.db).set(
      "own_key_max_total_tokens",
      2_000_000,
      null,
    );
    await h.enqueueNew({ prNumber: 8 });

    const second = await h.claimed(CLAIM);

    expect(first.job.input).toMatchObject({
      dynamic: { cost: { maxTotalTokens: 4_000_000 } },
    });
    expect(second.job.input).toMatchObject({
      dynamic: { cost: { maxTotalTokens: 2_000_000 } },
    });
  });
});

describe("a job that is not native", () => {
  // #553-T12
  it.each(["own", "managed"] as const)(
    "is unchanged on the %s key: no cost policy, and the price service is never asked",
    async (keyMode) => {
      const h = await start({ keyMode, provider: openrouterDescriptor.id });
      if (keyMode === "managed") {
        // The default entry of the harness is a legacy one.
        await h.reviewSettings.updateProjectSettings(h.repositoryId, {
          catalogEntryDynamic: h.defaultEntry!.id,
        });
      }

      const { job } = await h.claimed(CLAIM);

      expect(JSON.stringify(job.input)).not.toContain('"cost"');
      expect(JSON.stringify(job.input)).not.toContain('"modelEntry"');
      expect(h.asked).toEqual({ availability: 0, catalogPrice: 0 });
      expect(h.entries.count).toBe(0);
    },
  );

  // #553-T12, #578-T06
  it("is unchanged for a Diff job, whatever it selects", async () => {
    const h = await start({ keyMode: "own", dynamic: false });

    const { job } = await h.claimed({ llmProviders: BOTH });

    expect(JSON.stringify(job.input)).not.toContain('"cost"');
    expect(JSON.stringify(job.input)).not.toContain('"modelEntry"');
    expect(h.asked).toEqual({ availability: 0, catalogPrice: 0 });
    expect(h.entries.count).toBe(0);
  });

  // #553-T12
  it("is unchanged for a runner that never heard of the feature", async () => {
    const h = await start({
      keyMode: "own",
      provider: openrouterDescriptor.id,
    });

    const { job } = await h.claimed({
      engines: ["opencode"],
      features: ["dynamic_capabilities"],
      llmProviders: BOTH,
    });

    expect(JSON.stringify(job.input)).not.toContain('"cost"');
  });
});

describe("the model entry of a native job (#578)", () => {
  const counted = () => {
    const reads = { count: 0 };
    const checker: ModelCapabilityChecker = {
      check: async () => {
        reads.count += 1;
        return { outcome: "unverifiable" };
      },
    };
    return { reads, checker };
  };

  // #578-T03
  it("travels with the confirmed book of the managed key, on the claim and on the Worker's fetch", async () => {
    const claimed = await start({ keyMode: "managed" });
    const { job } = await claimed.claimed(CLAIM);
    const fetched = await start({ keyMode: "managed" });

    const { details } = await fetched.startedWorker(
      WORKER_FEATURES,
      BOTH.join(","),
      DISPATCHER,
    );

    for (const input of [job.input, details.job.input])
      expect(input).toMatchObject({
        dynamic: {
          cost: { keyMode: "managed", priceBook: BOOK },
          modelEntry: ENTRY,
        },
      });
  });

  // #578-T04
  it("travels with the policy of the own key too", async () => {
    const h = await start({ keyMode: "own" });

    const { job } = await h.claimed(CLAIM);

    expect(job.input).toMatchObject({
      dynamic: { cost: { keyMode: "own" }, modelEntry: ENTRY },
    });
  });

  // #578-T03
  it("holds no key, no price and no other model", async () => {
    const h = await start({ keyMode: "managed" });

    const { job } = await h.claimed(CLAIM);

    const dynamic = (job.input as { dynamic: { modelEntry: object } }).dynamic;
    const text = JSON.stringify(dynamic.modelEntry);
    for (const hidden of [
      FAKE_OPERATOR_KEY,
      WORKSPACE_KEY,
      FAKE_WORKSPACE_KEY,
      "660000",
    ])
      expect(text).not.toContain(hidden);
    expect(Object.keys(dynamic.modelEntry).sort()).toEqual(
      [
        "authHeader",
        "family",
        "model",
        "modelId",
        "npm",
        "providerId",
        "upstreamBaseUrl",
        "version",
      ].sort(),
    );
  });

  // #578-T05
  it("ends a managed job before any key or token exists when the catalog cannot describe the model", async () => {
    const h = await start({
      keyMode: "managed",
      entry: { ok: false, code: "provider_url_blocked" },
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

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
    expect(written).toContain("reason=entry_provider_url_blocked");
    for (const hidden of [NATIVE_MODEL, FAKE_PROVIDER_ID, "deepseek", "660000"])
      expect(written).not.toContain(hidden);
  });

  // #578-T28
  it("ends a job, before any key or token exists, when the address of a registry provider is not the registry's", async () => {
    for (const keyMode of ["managed", "own"] as const) {
      const h = await start({
        keyMode,
        entry: { ok: false, code: "upstream_not_registry" },
      });
      const [job] = await h.snapshotJobs();

      const response = await h.claim(CLAIM);

      expect(response.status).toBe(204);
      expect(await h.queue.get(job!.id)).toMatchObject({
        status: "failed",
        errorCode:
          keyMode === "managed"
            ? "managed_model_unavailable"
            : "dynamic_model_features_unsupported",
      });
      expect(h.issuedJobTokens()).toEqual([]);
      expect(h.keyLoads.count).toBe(0);
      expect(h.logLines().join("\n")).toContain(
        "reason=entry_upstream_not_registry",
      );
    }
  });

  // #578-T04
  it("ends an own-key job as a model Dynamic Review cannot use when the catalog does not have it", async () => {
    const h = await start({
      keyMode: "own",
      entry: { ok: false, code: "model_not_in_catalog" },
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_model_features_unsupported",
    });
    expect(h.issuedJobTokens()).toEqual([]);
    expect(h.keyLoads.count).toBe(0);
  });

  // #578-T05
  it("gives the job back, and does not end it, when the catalog could not be read", async () => {
    const h = await start({
      keyMode: "managed",
      entry: { ok: false, code: "check_failed" },
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

    expect(response.status).toBe(503);
    expect(await h.queue.get(job!.id)).toMatchObject({ status: "queued" });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #578-T05
  it("is not asked for when the price already refused the managed model", async () => {
    const h = await start({
      keyMode: "managed",
      availability: {
        selectable: false,
        reason: "price_unconfirmed",
        code: "catalog_price_unconfirmed",
      },
    });

    await h.claim(CLAIM);

    expect(h.entries.count).toBe(0);
  });

  // #578-T08
  it("never goes to a runner that did not say it enforces a cost policy, so the entry does not either", async () => {
    const h = await start({ keyMode: "own" });
    const [job] = await h.snapshotJobs();

    const response = await h.claim({
      engines: ["opencode"],
      features: ["dynamic_capabilities"],
      llmProviders: BOTH,
    });

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_engine_unavailable",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #578-T03
  it("does not read the legacy capability metadata of the provider: the entry states the window and the flags", async () => {
    const native = counted();
    const h = await start({ keyMode: "own", capabilities: native.checker });

    const { job } = await h.claimed(CLAIM);

    expect(native.reads.count).toBe(0);
    expect(JSON.stringify(job.input)).not.toContain('"capabilities"');
  });

  // #578-T01
  it("leaves the legacy read of the metadata alone for a job of today", async () => {
    const legacy = counted();
    const h = await start({
      keyMode: "own",
      provider: openrouterDescriptor.id,
      capabilities: legacy.checker,
    });

    await h.claimed(CLAIM);

    expect(legacy.reads.count).toBeGreaterThan(0);
  });
});
