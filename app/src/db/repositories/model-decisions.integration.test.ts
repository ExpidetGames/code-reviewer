// SPDX-License-Identifier: LicenseRef-Proprietary

// The admin's decisions about catalog models (#549, part B): whether a model is enabled for the managed
// key (one row per model, changed in place) and the append-only history of its price confirmations, the latest of which
// counts. The history cannot be changed or deleted, not even by a direct statement.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { StoredModel, StoredProvider } from "../../models-dev/catalog.ts";
import { createModelsDevRepository } from "./models-dev-repository.ts";
import { createModelEnablementsRepository } from "./model-enablements-repository.ts";
import { createModelPriceConfirmationsRepository } from "./model-price-confirmations-repository.ts";
import {
  priceBookFromCatalog,
  type PriceBook,
} from "../../model-prices/price-book.ts";
import { referenceHash } from "../../model-prices/price-hash.ts";
import { MODELS_DEV_ENGINES } from "../../test-support/models-dev-engines.ts";

const T1 = new Date("2026-10-20T08:00:00.000Z");
const T2 = new Date("2026-10-20T09:30:00.000Z");

const provider: StoredProvider = {
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
};

function model(id: string): StoredModel {
  return {
    providerId: "deepseek",
    id,
    name: id,
    family: null,
    limit: { context: 1000000, output: 384000 },
    reasoning: true,
    temperature: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    status: null,
    cost: { input: "0.6", output: "1.2", cacheRead: "0.06" },
    lastUpdated: null,
    interleaved: null,
    firstSeenAt: T1.toISOString(),
    unlistedAt: null,
    updatedAt: T1.toISOString(),
  };
}

const REFERENCE = priceBookFromCatalog(
  { input: "0.6", output: "1.2", cacheRead: "0.06" },
  undefined,
) as PriceBook;

describe.each(MODELS_DEV_ENGINES)(
  "the admin's model decisions on $name",
  (engine) => {
    async function setup() {
      const { db } = await engine.create();
      await createModelsDevRepository(db).apply({
        providers: [provider],
        models: [model("deepseek-v4-pro"), model("deepseek-v4-flash")],
      });
      return {
        db,
        enablements: createModelEnablementsRepository(db),
        confirmations: createModelPriceConfirmationsRepository(db),
      };
    }

    const confirm = (patch: Record<string, unknown> = {}) => ({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      source: "catalog" as const,
      book: REFERENCE,
      reference: REFERENCE,
      referenceHash: referenceHash(REFERENCE, { reasoning: false }),
      reason: null,
      confirmedBy: "admin-1",
      ...patch,
    });

    describe("enablement", () => {
      // #549-T06
      it("takes a decision back and says whether there was one", async () => {
        const { enablements } = await setup();
        await enablements.set(
          {
            providerId: "deepseek",
            modelId: "deepseek-v4-pro",
            enabled: false,
            changedBy: "admin-1",
          },
          T1,
        );

        const first = await enablements.clear("deepseek", "deepseek-v4-pro");
        const again = await enablements.clear("deepseek", "deepseek-v4-pro");

        expect(first).toBe(true);
        expect(again).toBe(false);
        expect(
          await enablements.get("deepseek", "deepseek-v4-pro"),
        ).toBeUndefined();
      });

      // #549-T06
      it("has no decision until the admin makes one", async () => {
        const { enablements } = await setup();

        expect(
          await enablements.get("deepseek", "deepseek-v4-pro"),
        ).toBeUndefined();
        expect(await enablements.list()).toEqual([]);
      });

      // #549-T06
      it("stores a decision and changes it in place, keeping who and when of the last change", async () => {
        const { enablements } = await setup();

        await enablements.set(
          {
            providerId: "deepseek",
            modelId: "deepseek-v4-pro",
            enabled: true,
            changedBy: "admin-1",
          },
          T1,
        );
        await enablements.set(
          {
            providerId: "deepseek",
            modelId: "deepseek-v4-pro",
            enabled: false,
            changedBy: "admin-2",
          },
          T2,
        );

        expect(await enablements.get("deepseek", "deepseek-v4-pro")).toEqual({
          providerId: "deepseek",
          modelId: "deepseek-v4-pro",
          enabled: false,
          changedBy: "admin-2",
          changedAt: T2.toISOString(),
        });
        expect(await enablements.list()).toHaveLength(1);
      });

      // #549-T06
      it("lists the models that are enabled, and only those", async () => {
        const { enablements } = await setup();
        await enablements.set(
          {
            providerId: "deepseek",
            modelId: "deepseek-v4-pro",
            enabled: true,
            changedBy: null,
          },
          T1,
        );
        await enablements.set(
          {
            providerId: "deepseek",
            modelId: "deepseek-v4-flash",
            enabled: false,
            changedBy: null,
          },
          T1,
        );

        expect(await enablements.listEnabled()).toEqual([
          { providerId: "deepseek", modelId: "deepseek-v4-pro" },
        ]);
      });

      // #549-T06
      it("refuses a decision about a model the catalog does not have", async () => {
        const { enablements } = await setup();

        await expect(
          enablements.set(
            {
              providerId: "deepseek",
              modelId: "nobody",
              enabled: true,
              changedBy: null,
            },
            T1,
          ),
        ).rejects.toThrow();
      });
    });

    describe("price confirmations", () => {
      // #549-T04
      it("appends a confirmation and gives back exactly the book, the reference and the hash", async () => {
        const { confirmations } = await setup();

        const saved = await confirmations.append(confirm(), T1);

        expect(saved).toEqual({
          id: expect.any(Number),
          providerId: "deepseek",
          modelId: "deepseek-v4-pro",
          source: "catalog",
          book: REFERENCE,
          reference: REFERENCE,
          referenceHash: referenceHash(REFERENCE, { reasoning: false }),
          reason: null,
          confirmedBy: "admin-1",
          confirmedAt: T1.toISOString(),
        });
        expect(
          await confirmations.latest("deepseek", "deepseek-v4-pro"),
        ).toEqual(saved);
      });

      // #549-T04
      it("keeps the history when the price is corrected, and the latest row counts", async () => {
        const { confirmations } = await setup();
        const first = await confirmations.append(confirm(), T1);
        const corrected = { ...REFERENCE, input: BigInt(700_000) };

        const second = await confirmations.append(
          confirm({
            source: "admin",
            book: corrected,
            reason: "Invoice of October.",
          }),
          T2,
        );

        expect(second.id).toBeGreaterThan(first.id);
        expect(
          await confirmations.latest("deepseek", "deepseek-v4-pro"),
        ).toEqual(second);
        const history = await confirmations.history(
          "deepseek",
          "deepseek-v4-pro",
        );
        expect(history.map((row) => row.id)).toEqual([second.id, first.id]);
        expect(history[1]?.book).toEqual(REFERENCE);
        expect(history[0]?.book.input).toBe(BigInt(700_000));
        expect(history[0]?.reason).toBe("Invoice of October.");
      });

      // #549-T04
      it("lists the latest confirmation of every model, once", async () => {
        const { confirmations } = await setup();
        await confirmations.append(confirm(), T1);
        const latest = await confirmations.append(
          confirm({
            source: "admin",
            book: { ...REFERENCE, output: BigInt(2_000_000) },
            reason: "x",
          }),
          T2,
        );
        const other = await confirmations.append(
          confirm({ modelId: "deepseek-v4-flash" }),
          T1,
        );

        const rows = await confirmations.listLatest();

        expect(rows.map((row) => row.id).sort()).toEqual(
          [latest.id, other.id].sort(),
        );
      });

      // #549-T04
      it("stores a confirmation of a model the catalog does not price, with no reference", async () => {
        const { confirmations } = await setup();

        const saved = await confirmations.append(
          confirm({
            source: "admin",
            reference: null,
            referenceHash: referenceHash(null, { reasoning: false }),
            reason: "From the provider's page.",
          }),
          T1,
        );

        expect(saved.reference).toBeNull();
        expect(saved.referenceHash).toBe(
          referenceHash(null, { reasoning: false }),
        );
      });

      // #549-T04
      it("has no confirmation for a model nobody confirmed", async () => {
        const { confirmations } = await setup();

        expect(
          await confirmations.latest("deepseek", "deepseek-v4-pro"),
        ).toBeUndefined();
        expect(
          await confirmations.history("deepseek", "deepseek-v4-pro"),
        ).toEqual([]);
      });

      // #549-T04
      it("refuses a confirmation of a model the catalog does not have", async () => {
        const { confirmations } = await setup();

        await expect(
          confirmations.append(confirm({ modelId: "nobody" }), T1),
        ).rejects.toThrow();
      });

      // #549-T04
      it("refuses to change or delete a confirmation, whoever tries", async () => {
        const { db, confirmations } = await setup();
        const saved = await confirmations.append(confirm(), T1);

        await expect(
          sql`update model_price_confirmations set confirmed_by = 'someone' where seq = ${saved.id}`.execute(
            db,
          ),
        ).rejects.toThrow(/model_price_confirmations_immutable/);
        await expect(
          sql`delete from model_price_confirmations where seq = ${saved.id}`.execute(
            db,
          ),
        ).rejects.toThrow(/model_price_confirmations_immutable/);
        expect(
          await confirmations.latest("deepseek", "deepseek-v4-pro"),
        ).toEqual(saved);
      });

      // #549-T04
      it("refuses a correction without a reason and a confirmation as shown without a reference, by the table itself", async () => {
        const { db, confirmations } = await setup();

        await expect(
          confirmations.append(confirm({ source: "admin", reason: null }), T1),
        ).rejects.toThrow();
        await expect(
          confirmations.append(
            confirm({
              reference: null,
              referenceHash: referenceHash(null, { reasoning: false }),
            }),
            T1,
          ),
        ).rejects.toThrow();
        await expect(
          sql`insert into model_price_confirmations (provider_id, model_id, source, price, reference_hash, confirmed_at)
          values ('deepseek', 'deepseek-v4-pro', 'someone', '{}', 'h', ${T1.toISOString()})`.execute(
            db,
          ),
        ).rejects.toThrow();
      });

      // #549-T04
      it("reports a row whose price was damaged outside the app as unreadable, never as no confirmation and never as the row before it", async () => {
        const { db, confirmations } = await setup();
        await confirmations.append(confirm({}), T1);
        const damaged = await db
          .insertInto("model_price_confirmations")
          .values({
            provider_id: "deepseek",
            model_id: "deepseek-v4-pro",
            source: "catalog",
            price: "{not json",
            reference_price: "{}",
            reference_hash: "h",
            reason: null,
            confirmed_by: null,
            confirmed_at: T1.toISOString(),
          })
          .returning("seq")
          .executeTakeFirstOrThrow();

        const latest = await confirmations.latest(
          "deepseek",
          "deepseek-v4-pro",
        );
        const all = await confirmations.listLatest();

        expect(latest).toEqual({
          unreadable: true,
          id: Number(damaged.seq),
          providerId: "deepseek",
          modelId: "deepseek-v4-pro",
        });
        expect(all).toEqual([latest]);
      });
    });
  },
);
