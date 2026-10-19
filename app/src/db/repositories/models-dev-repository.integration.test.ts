// SPDX-License-Identifier: Apache-2.0

// The stored models.dev catalog (#548) on both engines: rows round-trip, an upsert keeps `first_seen_at`, nothing is ever
// deleted, and the state of the last fetch is one row that a failure changes without touching the catalog.
import { describe, expect, it } from "vitest";
import type { StoredModel, StoredProvider } from "../../models-dev/catalog.ts";
import { MODELS_DEV_ENGINES } from "../../test-support/models-dev-engines.ts";
import { createModelsDevRepository } from "./models-dev-repository.ts";

const T1 = new Date("2026-10-19T03:00:00.000Z");
const T2 = new Date("2026-10-20T03:00:00.000Z");

function provider(overrides: Partial<StoredProvider> = {}): StoredProvider {
  return {
    id: "deepseek",
    name: "DeepSeek",
    url: {
      state: "trusted",
      trustedUrl: "https://api.deepseek.com",
      pendingUrl: null,
      problem: null,
    },
    urlChangedAt: null,
    firstSeenAt: T1.toISOString(),
    unlistedAt: null,
    updatedAt: T1.toISOString(),
    ...overrides,
  };
}

function model(overrides: Partial<StoredModel> = {}): StoredModel {
  return {
    providerId: "deepseek",
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    family: "deepseek-pro",
    limit: { context: 1000000, output: 384000 },
    reasoning: true,
    temperature: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    status: null,
    cost: { input: "0.6", output: "1.2", cacheRead: "0.06" },
    lastUpdated: "2026-10-17",
    interleaved: { field: "reasoning_content" },
    firstSeenAt: T1.toISOString(),
    unlistedAt: null,
    updatedAt: T1.toISOString(),
    ...overrides,
  };
}

describe.each(MODELS_DEV_ENGINES)(
  "the models.dev catalog on $name",
  (engine) => {
    const it_ = engine.skip ? it.skip : it;

    async function setup() {
      const { db } = await engine.create();
      return { db, repository: createModelsDevRepository(db) };
    }

    // #548-T03
    it_(
      "gives back exactly what it was given, prices, modalities and optional fields included",
      async () => {
        const { repository } = await setup();
        const withTiers = model({
          id: "tiered",
          status: "deprecated",
          limit: { context: 200000, output: 8192, input: 190000 },
          cost: {
            input: "1",
            output: "5",
            tiers: [{ contextOver: 100000, input: "2", output: "10" }],
          },
          interleaved: true,
          family: null,
          lastUpdated: null,
        });
        const unpriced = model({
          id: "unpriced",
          cost: null,
          interleaved: null,
        });

        await repository.apply({
          providers: [provider()],
          models: [model(), withTiers, unpriced],
        });

        expect(await repository.listProviders()).toEqual([provider()]);
        expect((await repository.listModels()).map((m) => m.id).sort()).toEqual(
          ["deepseek-v4-pro", "tiered", "unpriced"],
        );
        expect(await repository.getModel("deepseek", "tiered")).toEqual(
          withTiers,
        );
        expect(await repository.getModel("deepseek", "unpriced")).toEqual(
          unpriced,
        );
        expect(await repository.getModel("deepseek", "nobody")).toBeUndefined();
        expect(await repository.getProvider("nobody")).toBeUndefined();
      },
    );

    // #548-T03
    it_(
      "updates a row on a second write and keeps the day it was first seen",
      async () => {
        const { repository } = await setup();
        await repository.apply({ providers: [provider()], models: [model()] });

        await repository.apply({
          providers: [
            provider({ name: "DeepSeek AI", updatedAt: T2.toISOString() }),
          ],
          models: [
            model({
              cost: { input: "0.5", output: "1.1" },
              firstSeenAt: T2.toISOString(),
              updatedAt: T2.toISOString(),
            }),
          ],
        });

        const stored = await repository.getModel("deepseek", "deepseek-v4-pro");
        expect(stored?.cost).toEqual({ input: "0.5", output: "1.1" });
        expect(stored?.firstSeenAt).toBe(T1.toISOString());
        expect(stored?.updatedAt).toBe(T2.toISOString());
        const stored2 = await repository.getProvider("deepseek");
        expect(stored2?.name).toBe("DeepSeek AI");
        expect(stored2?.firstSeenAt).toBe(T1.toISOString());
      },
    );

    // #548-T03
    it_(
      "marks a row unlisted and clears it again, with the last known entry kept in between",
      async () => {
        const { repository } = await setup();
        await repository.apply({ providers: [provider()], models: [model()] });

        await repository.apply({
          providers: [],
          models: [
            model({
              unlistedAt: T2.toISOString(),
              updatedAt: T2.toISOString(),
            }),
          ],
        });
        const gone = await repository.getModel("deepseek", "deepseek-v4-pro");
        expect(gone?.unlistedAt).toBe(T2.toISOString());
        expect(gone?.cost).toEqual({
          input: "0.6",
          output: "1.2",
          cacheRead: "0.06",
        });

        await repository.apply({
          providers: [],
          models: [model({ updatedAt: T2.toISOString() })],
        });
        expect(
          (await repository.getModel("deepseek", "deepseek-v4-pro"))
            ?.unlistedAt,
        ).toBeNull();
      },
    );

    // #548-T08
    it_("keeps the trusted address and the one that waits apart", async () => {
      const { repository } = await setup();
      const blocked = provider({
        url: {
          state: "url_changed",
          trustedUrl: "https://api.deepseek.com",
          pendingUrl: "https://elsewhere.example/v1",
          problem: null,
        },
        urlChangedAt: T2.toISOString(),
      });

      await repository.apply({ providers: [provider()], models: [] });
      await repository.apply({ providers: [blocked], models: [] });

      expect(await repository.getProvider("deepseek")).toEqual(blocked);
    });

    // #548-T04
    it_(
      "records a failure in one row without touching the catalog, and a success after it",
      async () => {
        const { repository } = await setup();
        await repository.apply({ providers: [provider()], models: [model()] });
        expect(await repository.fetchState()).toBeUndefined();

        await repository.recordFailure("models_dev_http_status", T1);
        await repository.recordFailure("models_dev_unreachable", T2);

        expect(await repository.fetchState()).toEqual({
          lastAttemptAt: T2.toISOString(),
          lastSuccessAt: null,
          lastStatus: "failed",
          lastError: "models_dev_unreachable",
          lastSummary: null,
        });
        expect(await repository.listModels()).toHaveLength(1);

        const summary = { providers: 1, models: 1 };
        await repository.recordSuccess(summary, T2);
        expect(await repository.fetchState()).toEqual({
          lastAttemptAt: T2.toISOString(),
          lastSuccessAt: T2.toISOString(),
          lastStatus: "ok",
          lastError: null,
          lastSummary: summary,
        });

        await repository.recordFailure(
          "models_dev_invalid_body",
          new Date(T2.getTime() + 1000),
        );
        const after = await repository.fetchState();
        expect(after?.lastSuccessAt).toBe(T2.toISOString());
        expect(after?.lastError).toBe("models_dev_invalid_body");
      },
    );

    // #548-T03
    it_("writes many rows at once", async () => {
      const { repository } = await setup();
      const models = Array.from({ length: 450 }, (_unused, index) =>
        model({ id: `model-${String(index)}` }),
      );

      await repository.apply({ providers: [provider()], models });

      expect(await repository.listModels()).toHaveLength(450);
    });
  },
);
