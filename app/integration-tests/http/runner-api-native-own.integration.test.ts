// SPDX-License-Identifier: Apache-2.0

// The claim of a Dynamic job on the workspace's own key with a model of the models.dev catalog (#555), through the real claim
// with the real key service and catalog reader over a database filled with rows: the selection is resolved from the catalog
// before any key is loaded, the entry of the model is built, only the key of that provider is revealed, and a model that is
// gone, or a provider that is blocked, fails closed with a clear notice and no fallback. The price service is a stub: the
// token cap and the price book are the policy of #553, pinned there.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createModelsDevRepository } from "../../src/db/repositories/models-dev-repository.ts";
import { createUsageRecordsRepository } from "../../src/db/repositories/usage-records-repository.ts";
import { llmProviderDescriptors } from "../../src/llm/providers/index.ts";
import type {
  StoredModel,
  StoredProvider,
} from "../../src/models-dev/catalog.ts";
import type { PriceBookJson } from "../../src/model-prices/price-book.ts";
import { sha } from "../../src/test-support/jobs.ts";
import { registryAddressesOf } from "../../src/native-cost/registry-addresses.ts";
import { createNativeCostService } from "../../src/native-cost/service.ts";
import { createNativeCatalogReader } from "../../src/native-providers/catalog.ts";
import type { ProviderPins } from "../../src/runner-api/provider-pins.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const DEEPSEEK_KEY = "plain-deepseek-key-0001-aaaaaaaaaaaa";
const OPENAI_KEY = "plain-openai-key-0002-bbbbbbbbbbbbbb";
const OPENROUTER_KEY = "plain-openrouter-key-0003-ccccccccc";
const LEGACY = llmProviderDescriptors.ids;
const CLAIM = {
  engines: ["opencode"],
  features: ["dynamic_capabilities", "dynamic_cost_policy"],
};
const T1 = "2026-10-19T03:00:00.000Z";
const BOOK: PriceBookJson = {
  input: "660000",
  output: "1980000",
  cacheRead: null,
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: null,
  inputAudio: null,
  outputAudio: null,
  contextOver200k: null,
  tiers: [],
};

function provider(
  id: string,
  overrides: Partial<StoredProvider> = {},
): StoredProvider {
  return {
    id,
    name: id,
    url: {
      state: "trusted",
      trustedUrl: `https://api.${id}.example`,
      pendingUrl: null,
      problem: null,
    },
    urlChangedAt: null,
    firstSeenAt: T1,
    unlistedAt: null,
    updatedAt: T1,
    ...overrides,
  };
}
function model(
  providerId: string,
  id: string,
  overrides: Partial<StoredModel> = {},
): StoredModel {
  return {
    providerId,
    id,
    name: id,
    family: null,
    limit: { context: 128_000, output: 8_000 },
    reasoning: false,
    temperature: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    status: null,
    cost: { input: "0.66", output: "1.98" },
    lastUpdated: null,
    interleaved: null,
    firstSeenAt: T1,
    unlistedAt: null,
    updatedAt: T1,
    ...overrides,
  };
}

type Started = RunnerApiHarness & { keyLoads: { count: number } };

async function start(
  options: {
    /** The key of the provider the project selects; the workspace has a key of the other provider only when left out. */
    keyOf?: "deepseek" | "openai" | "none";
    catalogPrice?: PriceBookJson | null;
    selectModel?: string;
    /** #588: where the claim adopts the address of a selection made before pins existed; default the real one. */
    providerPins?: ProviderPins;
    /** Rows of the catalog written after the project saved its selection (the model leaves, the address changes). */
    afterSave?: (
      repository: ReturnType<typeof createModelsDevRepository>,
      db: RunnerApiHarness["db"],
    ) => Promise<void>;
  } = {},
): Promise<Started> {
  let dbRef: RunnerApiHarness["db"] | null = null;
  const lazyRepository = () => {
    if (dbRef === null) throw new Error("database not ready");
    return createModelsDevRepository(dbRef);
  };
  const reader = createNativeCatalogReader({
    models: {
      listProviders: (o) => lazyRepository().listProviders(o),
      listedModelCounts: (id) => lazyRepository().listedModelCounts(id),
      getProvider: (id, o) => lazyRepository().getProvider(id, o),
      listModelsOf: (id) => lazyRepository().listModelsOf(id),
      getModel: (p, m) => lazyRepository().getModel(p, m),
    },
    legacyProviders: LEGACY,
  });
  const keyLoads = { count: 0 };
  const h = await startRunnerApiHarness({
    llmKey: OPENROUTER_KEY,
    projects: true,
    env: { LLM_MODEL: "vendor/instance-model", LLM_MAX_TOKENS: "64000" },
    nativeCost: createNativeCostService({
      prices: {
        availability: () =>
          Promise.reject(new Error("an own job asks no availability")),
        catalogPrice: () =>
          Promise.resolve(
            options.catalogPrice === undefined ? BOOK : options.catalogPrice,
          ),
      },
      settings: {
        get: (key) =>
          dbRef === null
            ? Promise.resolve(undefined)
            : createInstanceSettingsRepository(dbRef).get(key),
      },
      catalog: {
        getProvider: (id, o) => lazyRepository().getProvider(id, o),
        getModel: (p, m) => lazyRepository().getModel(p, m),
      },
      legacyProviders: LEGACY,
      registryAddresses: registryAddressesOf(llmProviderDescriptors.providers),
    }),
    nativeCatalog: reader,
    onKeyLoad: () => {
      keyLoads.count += 1;
    },
    ...(options.providerPins === undefined
      ? {}
      : { providerPins: options.providerPins }),
  });
  dbRef = h.db;
  const repository = createModelsDevRepository(h.db);
  await repository.apply({
    providers: [provider("deepseek"), provider("openai"), provider("google")],
    models: [
      model("deepseek", "deepseek-v4-pro"),
      model("deepseek", "unlisted-one", { unlistedAt: T1 }),
      model("openai", "gpt-5.5"),
      model("google", "gemini-3.5-flash"),
    ],
  });
  if (options.keyOf === "deepseek") await h.setLlmKey(DEEPSEEK_KEY, "deepseek");
  if (options.keyOf !== "deepseek" && options.keyOf !== "none")
    await h.setLlmKey(OPENAI_KEY, "openai");
  if (options.keyOf === "none") await h.setLlmKey(OPENAI_KEY, "openai");
  await h.projectService.activateProject(h.repositoryId);
  await h.reviewSettings.updateProjectSettings(h.repositoryId, {
    reviewKind: "dynamic",
    dynamicProvider: "deepseek",
    dynamicModel: options.selectModel ?? "deepseek-v4-pro",
  });
  await options.afterSave?.(repository, h.db);
  await h.enqueueNew();
  return Object.assign(h, { keyLoads });
}

describe("the claim of a catalog model on the workspace's own key", () => {
  // #555-T05
  it("resolves the selection from the catalog, reveals only the key of that provider and carries the cost policy of an own key", async () => {
    const h = await start({ keyOf: "deepseek" });
    await h.setLlmKey(OPENAI_KEY, "openai");

    const { job } = await h.claimed(CLAIM);

    expect(job.input).toMatchObject({
      reviewKind: "dynamic",
      llm: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: DEEPSEEK_KEY,
      },
      dynamic: {
        cost: { keyMode: "own", priceBook: BOOK, maxTotalTokens: 4_000_000 },
        // The destination of the key is the address the catalog trusts for the provider, in the claim's entry (#555-T13).
        modelEntry: {
          providerId: "deepseek",
          modelId: "deepseek-v4-pro",
          upstreamBaseUrl: "https://api.deepseek.example",
        },
      },
    });
    const sent = JSON.stringify(job.input);
    expect(sent).not.toContain(OPENAI_KEY);
    expect(sent).not.toContain(OPENROUTER_KEY);
    expect(h.logLines().join("\n")).not.toContain(DEEPSEEK_KEY);
    expect(
      await createUsageRecordsRepository(h.db, h.workspaceId, h.clock.now).get(
        job.id,
      ),
    ).toMatchObject({ llmProvider: "deepseek", keyMode: "own" });
  });

  // #555-T07
  it("carries no price book and the token cap for a model with no price", async () => {
    const h = await start({ keyOf: "deepseek", catalogPrice: null });

    const { job } = await h.claimed(CLAIM);

    expect(job.input).toMatchObject({
      dynamic: {
        cost: { keyMode: "own", priceBook: null, maxTotalTokens: 4_000_000 },
      },
    });
  });

  // #555-T06
  it("fails with llm_not_configured when the workspace has a key only for another provider, and never uses that key", async () => {
    const h = await start({ keyOf: "none" });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.issuedJobTokens()).toEqual([]);
    const written = h.logLines().join("\n");
    expect(written).toContain("no_key");
    expect(written).not.toContain(OPENAI_KEY);
  });

  // #555-T09
  it("fails closed with llm_model_unavailable when the catalog no longer holds the model, with no key loaded and no fallback", async () => {
    const h = await start({
      keyOf: "deepseek",
      afterSave: async (_repository, db) => {
        await db
          .deleteFrom("models_dev_models")
          .where("model_id", "=", "deepseek-v4-pro")
          .execute();
      },
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_model_unavailable",
    });
    expect(h.issuedJobTokens()).toEqual([]);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
  });

  // #555-T09
  it("fails closed with llm_provider_unsupported when the provider is blocked since the settings were saved", async () => {
    const h = await start({
      keyOf: "deepseek",
      afterSave: async (repository) => {
        const [stored] = (await repository.listProviders()).filter(
          (p) => p.id === "deepseek",
        );
        await repository.apply({
          providers: [
            {
              ...stored!,
              url: {
                ...stored!.url,
                state: "url_changed",
                pendingUrl: "https://elsewhere.example",
              },
            },
          ],
          models: [],
        });
      },
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_provider_unsupported",
    });
  });

  // #555-T13
  it("fails closed with llm_provider_unsupported for a provider whose address changed to an attacker's and was not confirmed: no key is loaded", async () => {
    const h = await start({
      keyOf: "deepseek",
      afterSave: async (repository) => {
        const [stored] = (await repository.listProviders()).filter(
          (p) => p.id === "deepseek",
        );
        await repository.apply({
          providers: [
            {
              ...stored!,
              url: {
                ...stored!.url,
                state: "url_changed",
                pendingUrl: "https://attacker.example/v1",
              },
            },
          ],
          models: [],
        });
      },
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_provider_unsupported",
    });
    expect(h.issuedJobTokens()).toEqual([]);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
    const written = h.logLines().join("\n");
    expect(written).toContain("entry_provider_url_blocked");
    expect(written).not.toContain("attacker");
    expect(written).not.toContain(DEEPSEEK_KEY);
  });

  // #555-T13
  it("fails closed with llm_provider_unsupported for a provider whose first address was refused, and never reveals the key", async () => {
    const h = await start({
      keyOf: "deepseek",
      afterSave: async (repository) => {
        const [stored] = (await repository.listProviders()).filter(
          (p) => p.id === "deepseek",
        );
        await repository.apply({
          providers: [
            {
              ...stored!,
              url: {
                state: "rejected",
                trustedUrl: null,
                pendingUrl: "https://10.0.0.5/v1",
                problem: "private_address",
              },
            },
          ],
          models: [],
        });
      },
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_provider_unsupported",
    });
    expect(h.issuedJobTokens()).toEqual([]);
    expect(h.logLines().join("\n")).not.toContain("10.0.0.5");
  });

  // #555-T13
  it.each([
    "https://API.deepseek.example",
    "https://api.deepseek.example/",
    "https://10.0.0.5/v1",
    "https://api.deepseek.example:8443",
  ])(
    "fails closed with llm_provider_unsupported when the stored trusted address %s is not a plain public https address in its canonical spelling",
    async (address) => {
      const h = await start({
        keyOf: "deepseek",
        afterSave: async (repository) => {
          const [stored] = (await repository.listProviders()).filter(
            (p) => p.id === "deepseek",
          );
          await repository.apply({
            providers: [
              { ...stored!, url: { ...stored!.url, trustedUrl: address } },
            ],
            models: [],
          });
        },
      });
      const [job] = await h.snapshotJobs();

      const response = await h.claim(CLAIM);

      expect(response.status).toBe(204);
      expect(await h.queue.get(job!.id)).toMatchObject({
        status: "failed",
        errorCode: "llm_provider_unsupported",
      });
      expect(h.issuedJobTokens()).toEqual([]);
      expect(
        await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
      ).toEqual([]);
    },
  );

  // #555-T09
  it("serves a model models.dev no longer lists, from the last known row: the settings warn, the run goes on", async () => {
    const h = await start({
      keyOf: "deepseek",
      selectModel: "deepseek-v4-pro",
    });
    await h.db
      .updateTable("models_dev_models")
      .set({ unlisted_at: T1 })
      .where("model_id", "=", "deepseek-v4-pro")
      .execute();

    const { job } = await h.claimed(CLAIM);

    expect(job.input).toMatchObject({
      llm: { provider: "deepseek", model: "deepseek-v4-pro" },
    });
  });

  // #555-T05
  it("is not offered to a caller without the dynamic cost policy: the token cap would not bind", async () => {
    const h = await start({ keyOf: "deepseek" });
    const [job] = await h.snapshotJobs();

    const response = await h.claim({ engines: ["opencode"] });

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_engine_unavailable",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });
});

describe("the address a selection is pinned to, at the claim (#588)", () => {
  const MOVED = "https://api.deepseek-moved.example";
  const ATTACKER = "https://api.attacker.example";

  /** The catalog trusts another address for deepseek: an admin confirmed a change (#548), or the catalog moved it. */
  async function trustAddress(
    repository: ReturnType<typeof createModelsDevRepository>,
    address: string,
  ) {
    const [stored] = (await repository.listProviders()).filter(
      (p) => p.id === "deepseek",
    );
    await repository.apply({
      providers: [{ ...stored!, url: { ...stored!.url, trustedUrl: address } }],
      models: [],
    });
  }

  async function pinOf(h: RunnerApiHarness): Promise<string | undefined> {
    const [row] = await h.db.selectFrom("projects").selectAll().execute();
    return (JSON.parse(row!.settings) as { dynamicProviderAddress?: string })
      .dynamicProviderAddress;
  }

  // #588-T19
  it("serves the claim at the address the project pinned when it selected the provider", async () => {
    const h = await start({ keyOf: "deepseek" });
    expect(await pinOf(h)).toBe("https://api.deepseek.example");

    const { job } = await h.claimed(CLAIM);

    expect(job.input).toMatchObject({
      dynamic: {
        modelEntry: { upstreamBaseUrl: "https://api.deepseek.example" },
      },
    });
    // The spy on the key load is wired: a served claim loads the key once.
    expect(h.keyLoads.count).toBe(1);
  });

  // #588-T20
  it("refuses a job whose catalog address moved after the selection with provider_address_changed: no key is loaded and the new address gets nothing", async () => {
    const h = await start({
      keyOf: "deepseek",
      afterSave: (repository) => trustAddress(repository, ATTACKER),
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

    expect(response.status).toBe(204);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "provider_address_changed",
    });
    // Nothing was issued or stored for the job: no token, no key, and the key was never asked for.
    expect(h.keyLoads.count).toBe(0);
    expect(h.issuedJobTokens()).toEqual([]);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
    const written = h.logLines().join("\n");
    expect(written).toContain("entry_provider_address_changed");
    expect(written).not.toContain("attacker");
    expect(written).not.toContain(DEEPSEEK_KEY);
    // The pin is untouched by the refusal.
    expect(await pinOf(h)).toBe("https://api.deepseek.example");
  });

  // #588-T21
  it("serves the job at the new address once the person confirms it in the settings of the project", async () => {
    const h = await start({
      keyOf: "deepseek",
      afterSave: (repository) => trustAddress(repository, MOVED),
    });
    const [first] = await h.snapshotJobs();
    expect((await h.claim(CLAIM)).status).toBe(204);
    expect(await h.queue.get(first!.id)).toMatchObject({
      errorCode: "provider_address_changed",
    });

    await h.reviewSettings.updateProjectSettings(
      h.repositoryId,
      { confirmProviderAddress: true },
      { canManageLlmKey: true },
    );
    await h.enqueueNew({ headSha: sha("b") });
    const { job } = await h.claimed(CLAIM);

    expect(job.input).toMatchObject({
      llm: { apiKey: DEEPSEEK_KEY },
      dynamic: { modelEntry: { upstreamBaseUrl: MOVED } },
    });
  });

  // #588-T22
  it("pins a selection made before pins existed at its first claim, and holds the next claim to that address", async () => {
    const h = await start({
      keyOf: "deepseek",
      afterSave: async (_repository, db) => {
        const [row] = await db.selectFrom("projects").selectAll().execute();
        const stored = JSON.parse(row!.settings) as Record<string, unknown>;
        delete stored.dynamicProviderAddress;
        await db
          .updateTable("projects")
          .set({ settings: JSON.stringify(stored) })
          .where("id", "=", row!.id)
          .execute();
      },
    });
    expect(await pinOf(h)).toBeUndefined();

    const { job } = await h.claimed(CLAIM);

    expect(job.input).toMatchObject({
      dynamic: {
        modelEntry: { upstreamBaseUrl: "https://api.deepseek.example" },
      },
    });
    expect(await pinOf(h)).toBe("https://api.deepseek.example");

    // The catalog moves; the next job is refused at the address the first claim pinned.
    await trustAddress(createModelsDevRepository(h.db), ATTACKER);
    await h.enqueueNew({ headSha: sha("b"), prNumber: 8 });
    expect((await h.claim(CLAIM)).status).toBe(204);
    const second = (await h.snapshotJobs()).find(
      (candidate) => candidate.id !== job.id,
    );
    expect(await h.queue.get(second!.id)).toMatchObject({
      errorCode: "provider_address_changed",
    });
  });

  /** A selection made before pins existed: the pin is taken out of the stored settings. */
  async function unpin(_repository: unknown, db: RunnerApiHarness["db"]) {
    const [row] = await db.selectFrom("projects").selectAll().execute();
    const stored = JSON.parse(row!.settings) as Record<string, unknown>;
    delete stored.dynamicProviderAddress;
    await db
      .updateTable("projects")
      .set({ settings: JSON.stringify(stored) })
      .where("id", "=", row!.id)
      .execute();
  }

  // #588-T51
  it("holds a claim that lost the race for the adoption to the pin in force: refused, with no key loaded and no token", async () => {
    const adopted: Array<{ provider: string; address: string }> = [];
    const h = await start({
      keyOf: "deepseek",
      afterSave: unpin,
      // Another claim pinned another address first: the answer is that pin.
      providerPins: {
        adopt: (_job, provider, address) => {
          adopted.push({ provider, address });
          return Promise.resolve(ATTACKER);
        },
      },
    });
    const [job] = await h.snapshotJobs();

    const response = await h.claim(CLAIM);

    expect(response.status).toBe(204);
    expect(adopted).toEqual([
      { provider: "deepseek", address: "https://api.deepseek.example" },
    ]);
    expect(await h.queue.get(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "provider_address_changed",
    });
    expect(h.keyLoads.count).toBe(0);
    expect(h.issuedJobTokens()).toEqual([]);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
    const written = h.logLines().join("\n");
    expect(written).toContain("entry_provider_address_changed");
    expect(written).not.toContain("attacker");
  });

  // #588-T52
  it("serves a claim whose adoption answers the very address it sends the key to", async () => {
    const h = await start({
      keyOf: "deepseek",
      afterSave: unpin,
      providerPins: {
        adopt: (_job, _provider, address) => Promise.resolve(address),
      },
    });

    const { job } = await h.claimed(CLAIM);

    expect(job.input).toMatchObject({ llm: { apiKey: DEEPSEEK_KEY } });
    expect(h.keyLoads.count).toBe(1);
  });

  // #588-T53
  it.each([
    ["fails", () => Promise.reject(new Error("pin store down"))],
    [
      "answers that the project no longer selects the provider",
      () => Promise.resolve(null),
    ],
  ])(
    "gives the job back with its own reason, not the price check's, when the adoption %s: no key, no token",
    async (_name, answer) => {
      const h = await start({
        keyOf: "deepseek",
        afterSave: unpin,
        providerPins: { adopt: answer },
      });
      const [job] = await h.snapshotJobs();

      const response = await h.claim(CLAIM);

      expect(response.status).toBe(503);
      const written = h.logLines().join("\n");
      expect(written).toContain("given back: provider_pin_check_failed");
      expect(written).not.toContain("price_check_failed");
      expect(written).not.toContain("pin store down");
      expect(await h.queue.get(job!.id)).toMatchObject({ status: "queued" });
      expect(h.keyLoads.count).toBe(0);
      expect(h.issuedJobTokens()).toEqual([]);
    },
  );

  // #588-T23
  it("does not pin a registry provider: the registry's address is in the code", async () => {
    const h = await start({ keyOf: "deepseek" });
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      dynamicProvider: "openrouter",
      dynamicModel: "vendor/model",
    });

    expect(await pinOf(h)).toBeUndefined();
  });
});
