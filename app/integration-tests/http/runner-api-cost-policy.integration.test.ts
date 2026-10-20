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
import { createNativeCostService } from "../../src/native-cost/service.ts";
import {
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
  keyLoads: { count: number };
};

async function start(options: {
  keyMode: "own" | "managed";
  dynamic?: boolean;
  availability?: ManagedAvailabilityJson;
  catalogPrice?: PriceBookJson | null;
  /** The provider the project selects; the fake one is the native one. */
  provider?: string;
}): Promise<Started> {
  const script = scriptedPrices(
    options.availability ?? CONFIRMED,
    options.catalogPrice === undefined ? BOOK : options.catalogPrice,
  );
  const keyLoads = { count: 0 };
  let settingsDb: ReturnType<typeof createInstanceSettingsRepository> | null =
    null;
  const h = await startRunnerApiHarness({
    llmKey: WORKSPACE_KEY,
    projects: true,
    providers: PROVIDERS,
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
        legacyProviders: [openrouterDescriptor.id],
      }),
      // The harness's second provider is the native one: the real map names no provider outside the legacy registry.
      refOf: (selection) =>
        selection.provider === FAKE_PROVIDER_ID
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
  return Object.assign(h, { asked: script.asked, keyLoads });
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
    expect(await recordOf(claimed, job.id)).toMatchObject({
      keyMode: "managed",
    });
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
      expect(h.asked).toEqual({ availability: 0, catalogPrice: 0 });
    },
  );

  // #553-T12
  it("is unchanged for a Diff job, whatever it selects", async () => {
    const h = await start({ keyMode: "own", dynamic: false });

    const { job } = await h.claimed({ llmProviders: BOTH });

    expect(JSON.stringify(job.input)).not.toContain('"cost"');
    expect(h.asked).toEqual({ availability: 0, catalogPrice: 0 });
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
