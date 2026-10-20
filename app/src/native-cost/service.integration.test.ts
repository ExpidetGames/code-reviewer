// SPDX-License-Identifier: Apache-2.0

// What the claim asks about the cost of a native job (#553), end to end over a real database on both engines, with the
// catalog filled by the real fetch against the models.dev fake and the real price service: the managed key (we pay) gets a
// policy only for a model that is enabled and has a confirmed price; the own key (the user pays the provider) is never
// blocked by a price and is bound by the instance's token cap, which the admin changes.
import { afterEach, describe, expect, it } from "vitest";
import {
  modelsDevFixture,
  startModelsDevFake,
  type ModelsDevFake,
} from "../../../fakes/models-dev/server.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { GUARD_REASONS } from "../models-dev/errors.ts";
import { createModelsDevService } from "../models-dev/service.ts";
import { createModelPriceService } from "../model-prices/service.ts";
import { MODELS_DEV_ENGINES } from "../test-support/models-dev-engines.ts";
import { createNativeCostService } from "./service.ts";

const T1 = new Date("2026-10-19T03:00:00.000Z");
const ADMIN = "admin-1";
const SONNET = { providerId: "anthropic", modelId: "claude-sonnet-5-5" };
const DEEPSEEK = { providerId: "deepseek", modelId: "deepseek-v4-pro" };
// The model-prices tests keep the price rules; here the legacy registry is the only thing the service needs to be told.
const LEGACY = ["openrouter", "anthropic"] as const;

const fakes: ModelsDevFake[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

describe.each(MODELS_DEV_ENGINES)(
  "the cost policy of a claim on $name",
  (engine) => {
    const it_ = engine.skip ? it.skip : it;

    async function setup() {
      const fake = await startModelsDevFake();
      fakes.push(fake);
      const { db } = await engine.create();
      const modelsDev = createModelsDevService({
        db,
        settings: () => ({ enabled: true, url: fake.url, warnings: [] }),
        resolveHost: async () => ["93.184.216.34"],
        now: () => T1,
        log: { info: () => undefined, error: () => undefined },
      });
      await modelsDev.refresh();
      const prices = createModelPriceService({
        db,
        now: () => T1,
        log: { info: () => undefined, error: () => undefined },
        overrideOf: () => undefined,
      });
      const settings = createInstanceSettingsRepository(db);
      const native = createNativeCostService({
        prices,
        settings,
        legacyProviders: LEGACY,
      });
      const confirm = async (ids: typeof SONNET) => {
        await prices.setEnabled(ADMIN, { ...ids, enabled: true });
        const view = await prices.get(ids.providerId, ids.modelId);
        if (!view.ok) throw new Error("no view");
        await prices.confirmPrice(ADMIN, {
          ...ids,
          referenceHash: view.model.price.reference.hash,
        });
      };
      return { db, fake, modelsDev, prices, settings, native, confirm };
    }

    describe("the managed key", () => {
      // #553-T01
      it_(
        "refuses a model that is enabled and has never been confirmed",
        async () => {
          const t = await setup();
          await t.prices.setEnabled(ADMIN, { ...DEEPSEEK, enabled: true });

          expect(
            await t.native.policyFor("managed", {
              providerId: "deepseek",
              modelId: "deepseek-v4-pro",
            }),
          ).toEqual({
            ok: false,
            code: "catalog_price_unconfirmed",
            reason: "price_unconfirmed",
          });
        },
      );

      // #553-T01
      it_(
        "refuses a model nobody enabled, however its price stands",
        async () => {
          const t = await setup();

          expect(await t.native.policyFor("managed", DEEPSEEK)).toEqual({
            ok: false,
            code: "catalog_model_unavailable",
            reason: "model_not_enabled",
          });
        },
      );

      // #553-T01
      it_("refuses a model whose confirmed price went stale", async () => {
        const t = await setup();
        await t.confirm(DEEPSEEK);
        expect((await t.native.policyFor("managed", DEEPSEEK)).ok).toBe(true);

        const body = modelsDevFixture() as Record<
          string,
          { models: Record<string, { cost: { output: number } }> }
        >;
        body.deepseek!.models["deepseek-v4-pro"]!.cost.output = 3;
        t.fake.respondWith(body);
        await t.modelsDev.refresh({
          acceptReasons: GUARD_REASONS,
        });

        expect(await t.native.policyFor("managed", DEEPSEEK)).toMatchObject({
          ok: false,
          code: "catalog_price_unconfirmed",
        });
      });

      // #553-T01
      it_("refuses a model nobody priced", async () => {
        const t = await setup();
        const body = modelsDevFixture() as Record<
          string,
          { models: Record<string, { cost?: unknown }> }
        >;
        delete body.deepseek!.models["deepseek-v4-pro"]!.cost;
        t.fake.respondWith(body);
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });
        await t.prices.setEnabled(ADMIN, { ...DEEPSEEK, enabled: true });

        expect(await t.native.policyFor("managed", DEEPSEEK)).toMatchObject({
          ok: false,
          code: "catalog_price_unconfirmed",
        });
      });

      // #553-T02
      it_(
        "carries the confirmed book as the only price source, and no token cap",
        async () => {
          const t = await setup();
          await t.confirm(DEEPSEEK);

          const outcome = await t.native.policyFor("managed", DEEPSEEK);

          expect(outcome).toMatchObject({
            ok: true,
            policy: {
              keyMode: "managed",
              maxTotalTokens: null,
              priceBook: {
                input: "660000",
                output: "1980000",
                cacheRead: "22000",
              },
            },
          });
        },
      );

      // #553-R04
      it_(
        "refuses a confirmed book that sells a cache write and no cache read",
        async () => {
          const t = await setup();
          await t.prices.setEnabled(ADMIN, { ...SONNET, enabled: true });
          const view = await t.prices.get(SONNET.providerId, SONNET.modelId);
          if (!view.ok) throw new Error("no view");
          const book = { ...view.model.price.reference.book!, cacheRead: null };
          await t.prices.correctPrice(ADMIN, {
            ...SONNET,
            referenceHash: view.model.price.reference.hash,
            price: book,
            reason: "test",
          });

          expect(await t.native.policyFor("managed", SONNET)).toEqual({
            ok: false,
            code: "catalog_price_unconfirmed",
            reason: "cache_read_unpriced",
          });
        },
      );
    });

    describe("the cache prices of the managed key", () => {
      // #577-L4
      it_(
        "refuses a confirmed model that states no cache read, until the admin states it in a correction",
        async () => {
          const t = await setup();
          const body = modelsDevFixture() as Record<
            string,
            { models: Record<string, { cost: Record<string, unknown> }> }
          >;
          delete body.deepseek!.models["deepseek-v4-pro"]!.cost.cache_read;
          t.fake.respondWith(body);
          await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });
          await t.confirm(DEEPSEEK);

          expect(await t.native.policyFor("managed", DEEPSEEK)).toEqual({
            ok: false,
            code: "catalog_price_unconfirmed",
            reason: "cache_read_unpriced",
          });
          const view = await t.prices.get(
            DEEPSEEK.providerId,
            DEEPSEEK.modelId,
          );
          if (!view.ok) throw new Error("no view");
          // The input price is the upper bound the admin may state.
          const price = {
            ...view.model.price.reference.book!,
            cacheRead: view.model.price.reference.book!.input,
          };
          const corrected = await t.prices.correctPrice(ADMIN, {
            ...DEEPSEEK,
            referenceHash: view.model.price.reference.hash,
            price,
            reason: "no cache price stated: the input price as the upper bound",
          });
          expect(corrected.ok).toBe(true);

          expect(await t.native.policyFor("managed", DEEPSEEK)).toMatchObject({
            ok: true,
            policy: { priceBook: { cacheRead: "660000" } },
          });
        },
      );
    });

    describe("the own key", () => {
      // #553-T04
      it_(
        "is never blocked by a price: the catalog's price is used even unconfirmed, with the cap",
        async () => {
          const t = await setup();

          const outcome = await t.native.policyFor("own", DEEPSEEK);

          expect(outcome).toMatchObject({
            ok: true,
            policy: {
              keyMode: "own",
              maxTotalTokens: 4_000_000,
              priceBook: { input: "660000", output: "1980000" },
            },
          });
        },
      );

      // #553-T05
      it_(
        "has no book for a model nobody priced and is still bound by the cap",
        async () => {
          const t = await setup();
          const body = modelsDevFixture() as Record<
            string,
            { models: Record<string, { cost?: unknown }> }
          >;
          delete body.deepseek!.models["deepseek-v4-pro"]!.cost;
          t.fake.respondWith(body);
          await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });

          expect(await t.native.policyFor("own", DEEPSEEK)).toEqual({
            ok: true,
            policy: {
              keyMode: "own",
              priceBook: null,
              maxTotalTokens: 4_000_000,
            },
            confirmation: null,
          });
        },
      );

      // #553-T11
      it_(
        "takes the cap from the instance setting at every claim",
        async () => {
          const t = await setup();
          expect(await t.native.policyFor("own", DEEPSEEK)).toMatchObject({
            policy: { maxTotalTokens: 4_000_000 },
          });

          await t.settings.set("own_key_max_total_tokens", 1_500_000, null);
          expect(await t.native.policyFor("own", DEEPSEEK)).toMatchObject({
            policy: { maxTotalTokens: 1_500_000 },
          });

          // A damaged value reads as the default, never as no cap.
          await t.settings.set("own_key_max_total_tokens", 7, null);
          expect(await t.native.policyFor("own", DEEPSEEK)).toMatchObject({
            policy: { maxTotalTokens: 4_000_000 },
          });
        },
      );
    });

    describe("the selection", () => {
      // #553-R10
      it_(
        "names a catalog model only for a provider that is not a legacy one",
        async () => {
          const t = await setup();

          expect(
            t.native.refOf({ provider: "deepseek", model: "deepseek-v4-pro" }),
          ).toEqual(DEEPSEEK);
          expect(
            t.native.refOf({
              provider: "anthropic",
              model: "claude-sonnet-5-5",
            }),
          ).toBeNull();
          expect(
            t.native.refOf({ provider: "openrouter", model: "vendor/model" }),
          ).toBeNull();
        },
      );
    });
  },
);
