// SPDX-License-Identifier: Apache-2.0

// The admin's price confirmation and enablement of catalog models (#549), end to end over a real database on both engines,
// with the catalog filled by the real fetch against the models.dev fake: a confirmation is kept and compared with today's
// reference price, a changed price makes it stale, a confirmation racing the daily fetch is never lost and never confirms
// a price the admin did not see, and every write leaves one audit line.
import { afterEach, describe, expect, it } from "vitest";
import {
  modelsDevFixture,
  startModelsDevFake,
  type ModelsDevFake,
} from "../../../fakes/models-dev/server.ts";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import { createModelPriceConfirmationsRepository } from "../db/repositories/model-price-confirmations-repository.ts";
import { createModelsDevService } from "../models-dev/service.ts";
import { MODELS_DEV_ENGINES } from "../test-support/models-dev-engines.ts";
import type { ModelOverride } from "./overrides.ts";
import {
  parsePriceBookJson,
  type PriceBook,
  type PriceBookJson,
} from "./price-book.ts";
import { createModelPriceService } from "./service.ts";

const DAY = 24 * 60 * 60 * 1000;
const T1 = new Date("2026-10-19T03:00:00.000Z");
const PUBLIC = async () => ["93.184.216.34"];
const ADMIN = "admin-1";

/** A book of the view's JSON form, as the repository takes it. */
function parsedBook(json: PriceBookJson | null) {
  if (json === null) return null;
  const parsed = parsePriceBookJson(json);
  if (!parsed.ok) throw new Error("not a book");
  return parsed.book;
}

const fakes: ModelsDevFake[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

type Body = Record<
  string,
  { api?: string; models: Record<string, Record<string, unknown>> }
>;

const SONNET = { providerId: "anthropic", modelId: "claude-sonnet-5-5" };
const DEEPSEEK = { providerId: "deepseek", modelId: "deepseek-v4-pro" };

describe.each(MODELS_DEV_ENGINES)("the model prices on $name", (engine) => {
  const it_ = engine.skip ? it.skip : it;

  async function setup(
    options: { overrides?: Record<string, ModelOverride> } = {},
  ) {
    const fake = await startModelsDevFake();
    fakes.push(fake);
    const { db } = await engine.create();
    let now = T1;
    const modelsDev = createModelsDevService({
      db,
      settings: () => ({ enabled: true, url: fake.url, warnings: [] }),
      resolveHost: PUBLIC,
      now: () => now,
      log: { info: () => undefined, error: () => undefined },
    });
    await modelsDev.refresh();
    const lines: string[] = [];
    const errors: string[] = [];
    const overrides = options.overrides ?? {};
    const service = createModelPriceService({
      db,
      now: () => now,
      log: {
        info: (line) => lines.push(line),
        error: (line) => errors.push(line),
      },
      overrideOf: (providerId, modelId) =>
        overrides[`${providerId}/${modelId}`],
    });
    return {
      db,
      fake,
      modelsDev,
      service,
      lines,
      errors,
      confirmations: createModelPriceConfirmationsRepository(db),
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
      body: () => modelsDevFixture() as Body,
      /** Another day's fetch with a changed body. */
      async fetchChanged(change: (body: Body) => void) {
        now = new Date(now.getTime() + DAY);
        const body = this.body();
        change(body);
        fake.respondWith(body);
        return modelsDev.refresh({ acceptLargeChange: true });
      },
    };
  }

  const view = async (t: Awaited<ReturnType<typeof setup>>, id = SONNET) => {
    const result = await t.service.get(id.providerId, id.modelId);
    if (!result.ok) throw new Error(`no view: ${result.code}`);
    return result.model;
  };

  describe("the view", () => {
    // #549-T02
    it_(
      "shows each model with its price status, its sources and its reference hash",
      async () => {
        const t = await setup();

        const model = await view(t);

        expect(model).toMatchObject({
          providerId: "anthropic",
          modelId: "claude-sonnet-5-5",
          enabled: null,
          price: {
            status: "unconfirmed",
            book: {
              input: "2000000",
              output: "10000000",
              cacheRead: "100000",
              cacheWrite5m: "2500000",
              cacheWrite1h: null,
            },
            reference: { hash: expect.stringMatching(/^v2:[0-9a-f]{64}$/) },
            confirmation: null,
          },
          managed: { selectable: false, reason: "model_not_enabled" },
        });
        expect(model.price.sources).toMatchObject({
          input: "catalog",
          cacheWrite1h: null,
        });
      },
    );

    // #549-T03
    it_(
      "takes the 1-hour cache write from the committed override file",
      async () => {
        const fake = await startModelsDevFake();
        fakes.push(fake);
        const { db } = await engine.create();
        await createModelsDevService({
          db,
          settings: () => ({ enabled: true, url: fake.url, warnings: [] }),
          resolveHost: PUBLIC,
          now: () => T1,
          log: { info: () => undefined, error: () => undefined },
        }).refresh();
        const service = createModelPriceService({
          db,
          now: () => T1,
          log: { info: () => undefined },
        });

        const result = await service.get("anthropic", "claude-sonnet-5-5");

        expect(result).toMatchObject({
          ok: true,
          model: { price: { book: { cacheWrite1h: "4000000" } } },
        });
        expect(result.ok && result.model.price.sources?.cacheWrite1h).toBe(
          "override",
        );
      },
    );

    // #549-T02
    it_("shows a model the catalog does not price as unpriced", async () => {
      const t = await setup();
      await t.fetchChanged((body) => {
        delete body.deepseek!.models["deepseek-v4-pro"]!.cost;
      });

      const model = await view(t, DEEPSEEK);

      expect(model.price).toMatchObject({ status: "unpriced", book: null });
    });

    // #549-T06
    it_(
      "calls a model new when it appeared after the first fetch and nobody decided on it",
      async () => {
        const t = await setup();
        expect((await t.service.list({})).newCount).toBe(0);
        await t.fetchChanged((body) => {
          body.deepseek!.models["deepseek-v5"] = {
            ...body.deepseek!.models["deepseek-v4-pro"],
            id: "deepseek-v5",
            name: "DeepSeek V5",
          };
        });

        const list = await t.service.list({});

        expect(list.newCount).toBe(1);
        expect(
          list.models.find((m) => m.modelId === "deepseek-v5")?.isNew,
        ).toBe(true);
        expect(
          list.models.find((m) => m.modelId === "deepseek-v4-pro")?.isNew,
        ).toBe(false);
        expect(
          (await t.service.list({ onlyNew: true })).models.map(
            (m) => m.modelId,
          ),
        ).toEqual(["deepseek-v5"]);
      },
    );

    // #549-T06
    it_(
      "stops calling a model new once the admin enabled or disabled it, whichever",
      async () => {
        const t = await setup();
        await t.fetchChanged((body) => {
          for (const id of ["a-new", "b-new"])
            body.deepseek!.models[id] = {
              ...body.deepseek!.models["deepseek-v4-pro"],
              id,
              name: id,
            };
        });
        expect((await t.service.list({})).newCount).toBe(2);

        await t.service.setEnabled(ADMIN, {
          providerId: "deepseek",
          modelId: "a-new",
          enabled: true,
        });
        await t.service.setEnabled(ADMIN, {
          providerId: "deepseek",
          modelId: "b-new",
          enabled: false,
        });

        expect((await t.service.list({})).newCount).toBe(0);
      },
    );

    // #549-T06
    it_(
      "calls a decided model new again when the admin resets the decision, and does not select it",
      async () => {
        const t = await setup();
        await t.fetchChanged((body) => {
          for (const id of ["a-new", "b-new"])
            body.deepseek!.models[id] = {
              ...body.deepseek!.models["deepseek-v4-pro"],
              id,
              name: id,
            };
        });
        const a = { providerId: "deepseek", modelId: "a-new" };
        const b = { providerId: "deepseek", modelId: "b-new" };
        await t.service.setEnabled(ADMIN, { ...a, enabled: true });
        await t.service.setEnabled(ADMIN, { ...b, enabled: false });
        expect((await t.service.list({})).newCount).toBe(0);
        t.lines.length = 0;

        const resetA = await t.service.resetDecision(ADMIN, a);
        const resetB = await t.service.resetDecision(ADMIN, b);

        expect(resetA).toMatchObject({
          ok: true,
          model: { enabled: null, enablement: null, isNew: true },
        });
        expect(resetB).toMatchObject({ ok: true, model: { isNew: true } });
        expect((await t.service.list({})).newCount).toBe(2);
        expect(await t.service.availability("deepseek", "a-new")).toMatchObject(
          { selectable: false, reason: "model_not_enabled" },
        );
        expect(t.lines).toEqual([
          `model prices: MODEL_DECISION_RESET by=${ADMIN} model=deepseek/a-new`,
          `model prices: MODEL_DECISION_RESET by=${ADMIN} model=deepseek/b-new`,
        ]);
      },
    );

    // #549-T06
    it_(
      "keeps the price confirmation when a decision is reset, so enabling again needs nothing more",
      async () => {
        const t = await setup();
        await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: (await view(t)).price.reference.hash,
        });
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });

        await t.service.resetDecision(ADMIN, SONNET);

        expect((await view(t)).price.status).toBe("confirmed");
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });
        expect(
          await t.service.availability("anthropic", "claude-sonnet-5-5"),
        ).toMatchObject({ selectable: true });
      },
    );

    // #549-T06
    it_(
      "resets a model without a decision to nothing and writes no audit line",
      async () => {
        const t = await setup();

        const result = await t.service.resetDecision(ADMIN, SONNET);

        expect(result).toMatchObject({ ok: true, model: { enabled: null } });
        expect(t.lines).toEqual([]);
      },
    );

    // #549-T10
    it_.each([
      [
        "a model the catalog does not have",
        { providerId: "deepseek", modelId: "nobody" },
        "model_unknown",
      ],
      ["an unknown field", { ...SONNET, enabled: true }, "request_invalid"],
      ["a missing model", { providerId: "deepseek" }, "request_invalid"],
    ])("refuses to reset %s", async (_name, input, code) => {
      const t = await setup();

      expect(await t.service.resetDecision(ADMIN, input)).toMatchObject({
        ok: false,
        code,
      });
    });

    // #549-T06
    it_(
      "filters by provider, search text, price status, enablement and page",
      async () => {
        const t = await setup();
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });
        await t.service.setEnabled(ADMIN, { ...DEEPSEEK, enabled: false });

        const ids = async (query: Parameters<typeof t.service.list>[0]) =>
          (await t.service.list(query)).models.map(
            (m) => `${m.providerId}/${m.modelId}`,
          );

        expect(await ids({ provider: "anthropic" })).toEqual(
          expect.arrayContaining(["anthropic/claude-sonnet-5-5"]),
        );
        expect(
          (await ids({ provider: "anthropic" })).every((id) =>
            id.startsWith("anthropic/"),
          ),
        ).toBe(true);
        expect(await ids({ search: "SONNET-5" })).toEqual([
          "anthropic/claude-sonnet-5-5",
        ]);
        expect(await ids({ enabled: "yes" })).toEqual([
          "anthropic/claude-sonnet-5-5",
        ]);
        expect(await ids({ enabled: "no" })).toEqual([
          "deepseek/deepseek-v4-pro",
        ]);
        expect((await ids({ enabled: "undecided" })).length).toBeGreaterThan(2);
        expect((await t.service.list({ priceStatus: "confirmed" })).total).toBe(
          0,
        );
        const all = await t.service.list({});
        const page = await t.service.list({ limit: 2, offset: 1 });
        expect(page.total).toBe(all.total);
        expect(page.models.map((m) => m.modelId)).toEqual(
          all.models.slice(1, 3).map((m) => m.modelId),
        );
      },
    );

    // #549-T11
    it_("carries the state of the last fetch", async () => {
      const t = await setup();

      expect((await t.service.list({})).fetch).toMatchObject({
        lastStatus: "ok",
        lastError: null,
      });
    });

    // #549-T10
    it_(
      "answers model_unknown for a model the catalog does not have",
      async () => {
        const t = await setup();

        expect(await t.service.get("anthropic", "nobody")).toEqual({
          ok: false,
          code: "model_unknown",
        });
      },
    );
  });

  describe("enablement", () => {
    // #549-T06
    it_("enables and disables a model and keeps who and when", async () => {
      const t = await setup();

      const enabled = await t.service.setEnabled(ADMIN, {
        ...SONNET,
        enabled: true,
      });
      t.advance(1000);
      const disabled = await t.service.setEnabled("admin-2", {
        ...SONNET,
        enabled: false,
      });

      expect(enabled).toMatchObject({ ok: true, model: { enabled: true } });
      expect(disabled).toMatchObject({
        ok: true,
        model: {
          enabled: false,
          enablement: {
            changedBy: "admin-2",
            changedAt: new Date(T1.getTime() + 1000).toISOString(),
          },
        },
      });
    });

    // #549-T10
    it_.each([
      ["a missing flag", { ...SONNET }],
      ["a flag that is text", { ...SONNET, enabled: "yes" }],
      [
        "a provider that is no string",
        { providerId: 1, modelId: "x", enabled: true },
      ],
      ["an unknown field", { ...SONNET, enabled: true, extra: 1 }],
    ])("refuses %s", async (_name, input) => {
      const t = await setup();

      expect(await t.service.setEnabled(ADMIN, input)).toMatchObject({
        ok: false,
        code: "request_invalid",
      });
      expect((await t.service.list({ enabled: "yes" })).total).toBe(0);
    });

    // #549-T10
    it_(
      "refuses a model the catalog does not have, and enabling a model the override file blocks",
      async () => {
        const t = await setup({
          overrides: {
            "anthropic/claude-sonnet-5-5": {
              reason: "Blocked.",
              cacheWrite1h: null,
              retiresNotBefore: null,
              blocked: true,
            },
          },
        });

        expect(
          await t.service.setEnabled(ADMIN, {
            providerId: "anthropic",
            modelId: "nobody",
            enabled: true,
          }),
        ).toEqual({
          ok: false,
          code: "model_unknown",
        });
        expect(
          await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true }),
        ).toMatchObject({
          ok: false,
          code: "model_blocked",
        });
        expect(
          await t.service.setEnabled(ADMIN, { ...SONNET, enabled: false }),
        ).toMatchObject({ ok: true });
      },
    );
  });

  describe("confirming a price", () => {
    const confirm = async (t: Awaited<ReturnType<typeof setup>>, id = SONNET) =>
      t.service.confirmPrice(ADMIN, {
        ...id,
        referenceHash: (await view(t, id)).price.reference.hash,
      });

    // #549-T04
    it_(
      "confirms the price as shown and keeps the hash of the catalog price",
      async () => {
        const t = await setup();
        const shown = await view(t);

        const result = await confirm(t);

        expect(result).toMatchObject({
          ok: true,
          model: {
            price: {
              status: "confirmed",
              confirmation: {
                source: "catalog",
                confirmedBy: ADMIN,
                reason: null,
              },
            },
          },
        });
        const stored = await t.confirmations.latest(
          "anthropic",
          "claude-sonnet-5-5",
        );
        expect(stored?.referenceHash).toBe(shown.price.reference.hash);
        expect(stored?.source).toBe("catalog");
        expect(stored?.confirmedAt).toBe(T1.toISOString());
      },
    );

    // #549-T04
    it_(
      "confirms as shown a model whose catalog lists its tiers from the largest context down",
      async () => {
        const t = await setup();
        await t.fetchChanged((body) => {
          body.anthropic!.models["claude-sonnet-5-5"]!.cost = {
            input: 2,
            output: 10,
            tiers: [
              {
                input: 6,
                output: 30,
                tier: { type: "context", size: 400000 },
              },
              {
                input: 4,
                output: 20,
                tier: { type: "context", size: 200000 },
              },
            ],
          };
        });
        const shown = await view(t);

        const result = await confirm(t);

        expect(result).toMatchObject({
          ok: true,
          model: { price: { status: "confirmed" } },
        });
        expect(
          shown.price.reference.book?.tiers.map((t) => t.contextOver),
        ).toEqual([200000, 400000]);
        expect(
          (await view(t)).price.confirmation?.book.tiers.map((t) => t.input),
        ).toEqual(["4000000", "6000000"]);
      },
    );

    // #549-T04
    it_(
      "keeps both rows when the price is corrected afterwards, and the latest counts",
      async () => {
        const t = await setup();
        await confirm(t);
        const shown = await view(t);
        const book = { ...shown.price.book!, input: "2500000" };

        const corrected = await t.service.correctPrice(ADMIN, {
          ...SONNET,
          referenceHash: shown.price.reference.hash,
          price: book,
          reason: "Invoice of October.",
        });

        expect(corrected).toMatchObject({
          ok: true,
          model: {
            price: {
              status: "confirmed",
              book: { input: "2500000" },
              sources: { input: "admin", output: "catalog" },
              confirmation: { source: "admin", reason: "Invoice of October." },
            },
          },
        });
        const history = await t.confirmations.history(
          "anthropic",
          "claude-sonnet-5-5",
        );
        expect(history.map((row) => row.source)).toEqual(["admin", "catalog"]);
        expect(history[1]?.book.input).toBe(BigInt(2_000_000));
      },
    );

    // #549-T04
    it_(
      "writes nothing when the model is confirmed again as it already is",
      async () => {
        const t = await setup();
        await confirm(t);

        const again = await confirm(t);

        expect(again).toMatchObject({
          ok: true,
          model: { price: { status: "confirmed" } },
        });
        expect(
          await t.confirmations.history("anthropic", "claude-sonnet-5-5"),
        ).toHaveLength(1);
      },
    );

    // #549-T05
    it_(
      "refuses to confirm a price the admin did not see, because it changed meanwhile",
      async () => {
        const t = await setup();
        const seen = (await view(t)).price.reference.hash;
        await t.fetchChanged((body) => {
          body.anthropic!.models["claude-sonnet-5-5"]!.cost = {
            input: 2.2,
            output: 10,
            cache_read: 0.1,
            cache_write: 2.5,
          };
        });

        const result = await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: seen,
        });

        expect(result).toMatchObject({ ok: false, code: "price_changed" });
        expect(
          await t.confirmations.latest("anthropic", "claude-sonnet-5-5"),
        ).toBeUndefined();
      },
    );

    // #549-T10
    it_("refuses to confirm a price the catalog does not state", async () => {
      const t = await setup();
      await t.fetchChanged((body) => {
        delete body.deepseek!.models["deepseek-v4-pro"]!.cost;
      });
      const hash = (await view(t, DEEPSEEK)).price.reference.hash;

      expect(
        await t.service.confirmPrice(ADMIN, {
          ...DEEPSEEK,
          referenceHash: hash,
        }),
      ).toMatchObject({
        ok: false,
        code: "price_missing",
      });
    });

    // #549-T10
    it_.each([
      ["no hash", {}],
      ["a hash that is no string", { referenceHash: 1 }],
      ["an unknown field", { referenceHash: "a".repeat(64), reason: "x" }],
    ])("refuses a confirmation with %s", async (_name, extra) => {
      const t = await setup();

      expect(
        await t.service.confirmPrice(ADMIN, { ...SONNET, ...extra }),
      ).toMatchObject({
        ok: false,
        code: "request_invalid",
      });
    });

    // #549-T10
    it_("refuses a model the catalog does not have", async () => {
      const t = await setup();

      expect(
        await t.service.confirmPrice(ADMIN, {
          providerId: "anthropic",
          modelId: "nobody",
          referenceHash: "a".repeat(64),
        }),
      ).toEqual({ ok: false, code: "model_unknown" });
    });
  });

  describe("correcting a price", () => {
    async function correct(
      t: Awaited<ReturnType<typeof setup>>,
      patch: (book: PriceBookJson) => unknown,
      extra: Record<string, unknown> = {},
    ) {
      const shown = await view(t);
      return t.service.correctPrice(ADMIN, {
        ...SONNET,
        referenceHash: shown.price.reference.hash,
        price: patch(shown.price.book!),
        reason: "Invoice of October.",
        ...extra,
      });
    }

    // #549-T10
    it_.each([
      ["a negative price", (book: PriceBookJson) => ({ ...book, input: "-1" })],
      ["NaN", (book: PriceBookJson) => ({ ...book, output: "NaN" })],
      [
        "a price above the sanity bound",
        (book: PriceBookJson) => ({ ...book, input: "100000000001" }),
      ],
      [
        "a tier that goes backwards",
        (book: PriceBookJson) => ({
          ...book,
          tiers: [
            {
              contextOver: 200000,
              input: "1",
              output: "2",
              cacheRead: null,
              cacheWrite5m: null,
              cacheWrite1h: null,
            },
            {
              contextOver: 100000,
              input: "1",
              output: "2",
              cacheRead: null,
              cacheWrite5m: null,
              cacheWrite1h: null,
            },
          ],
        }),
      ],
      ["a price that is no object", () => "free"],
    ])(
      "refuses %s with price_invalid and writes nothing",
      async (_name, patch) => {
        const t = await setup();

        expect(await correct(t, patch)).toMatchObject({
          ok: false,
          code: "price_invalid",
          field: "price",
        });
        expect(
          await t.confirmations.latest("anthropic", "claude-sonnet-5-5"),
        ).toBeUndefined();
      },
    );

    // #549-T10
    it_.each([
      ["no reason", { reason: undefined }],
      ["an empty reason", { reason: "  " }],
      ["a reason that is no text", { reason: 5 }],
      ["a reason on several lines", { reason: "a\nb" }],
      ["a reason that is too long", { reason: "x".repeat(501) }],
    ])("refuses %s with reason_invalid", async (_name, extra) => {
      const t = await setup();

      expect(await correct(t, (book) => book, extra)).toMatchObject({
        ok: false,
        code: "reason_invalid",
        field: "reason",
      });
      expect(
        await t.confirmations.latest("anthropic", "claude-sonnet-5-5"),
      ).toBeUndefined();
    });

    // #549-T10
    it_("lets the admin price a model the catalog does not price", async () => {
      const t = await setup();
      await t.fetchChanged((body) => {
        delete body.deepseek!.models["deepseek-v4-pro"]!.cost;
      });
      const shown = await view(t, DEEPSEEK);

      const result = await t.service.correctPrice(ADMIN, {
        ...DEEPSEEK,
        referenceHash: shown.price.reference.hash,
        price: { input: "700000", output: "2000000" },
        reason: "Price of the provider's page.",
      });

      expect(result).toMatchObject({
        ok: true,
        model: {
          price: {
            status: "confirmed",
            sources: { input: "admin", output: "admin" },
          },
        },
      });
    });

    // #549-T05
    it_(
      "refuses a correction made against a price that changed meanwhile",
      async () => {
        const t = await setup();
        const shown = await view(t);
        await t.fetchChanged((body) => {
          body.anthropic!.models["claude-sonnet-5-5"]!.cost = {
            input: 2.2,
            output: 10,
          };
        });

        const result = await t.service.correctPrice(ADMIN, {
          ...SONNET,
          referenceHash: shown.price.reference.hash,
          price: shown.price.book,
          reason: "Invoice.",
        });

        expect(result).toMatchObject({ ok: false, code: "price_changed" });
      },
    );
  });

  describe("a price that changes after the confirmation", () => {
    // #549-T05
    it_(
      "counts as stale, shows the old and the new price, and is confirmed again by the admin",
      async () => {
        const t = await setup();
        await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: (await view(t)).price.reference.hash,
        });

        await t.fetchChanged((body) => {
          body.anthropic!.models["claude-sonnet-5-5"]!.cost = {
            input: 2.2,
            output: 10,
            cache_read: 0.1,
            cache_write: 2.5,
          };
        });

        const stale = await view(t);
        expect(stale.price.status).toBe("stale");
        expect(stale.price.book?.input).toBe("2000000");
        expect(stale.price.reference.book?.input).toBe("2200000");
        expect(stale.price.confirmation?.confirmedBy).toBe(ADMIN);

        const again = await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: stale.price.reference.hash,
        });
        expect(again).toMatchObject({
          ok: true,
          model: { price: { status: "confirmed", book: { input: "2200000" } } },
        });
        expect(
          await t.confirmations.history("anthropic", "claude-sonnet-5-5"),
        ).toHaveLength(2);
      },
    );

    // #549-T05
    it_(
      "counts as stale when only the price of reasoning tokens changed",
      async () => {
        const t = await setup();
        await t.service.confirmPrice(ADMIN, {
          ...DEEPSEEK,
          referenceHash: (await view(t, DEEPSEEK)).price.reference.hash,
        });
        expect((await view(t, DEEPSEEK)).price.status).toBe("confirmed");

        await t.fetchChanged((body) => {
          const cost = body.deepseek!.models["deepseek-v4-pro"]!.cost as Record<
            string,
            unknown
          >;
          cost.reasoning = 2.5;
        });

        const stale = await view(t, DEEPSEEK);
        expect(stale.price.status).toBe("stale");
        expect(stale.price.book?.reasoning).toBe("1980000");
        expect(stale.price.reference.book?.reasoning).toBe("2500000");
      },
    );

    // #549-T05
    it_(
      "counts as stale when only the reasoning flag of the model changed",
      async () => {
        const t = await setup();
        await t.service.confirmPrice(ADMIN, {
          ...DEEPSEEK,
          referenceHash: (await view(t, DEEPSEEK)).price.reference.hash,
        });

        await t.fetchChanged((body) => {
          body.deepseek!.models["deepseek-v4-pro"]!.reasoning = false;
        });

        expect((await view(t, DEEPSEEK)).price.status).toBe("stale");
      },
    );

    // #549-T05
    it_(
      "refuses the managed key when the catalog adds a price we cannot read, and prices nothing new from it",
      async () => {
        const t = await setup();
        await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: (await view(t)).price.reference.hash,
        });
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });
        expect(
          await t.service.availability("anthropic", "claude-sonnet-5-5"),
        ).toMatchObject({
          selectable: true,
        });

        await t.fetchChanged((body) => {
          const cost = body.anthropic!.models["claude-sonnet-5-5"]!
            .cost as Record<string, unknown>;
          cost.tiers = [
            { input: 4, output: 20, tier: { type: "time_of_day", size: 12 } },
          ];
        });

        const model = await view(t);
        expect(model.price.status).toBe("stale");
        expect(model.price.reference.book).toBeNull();
        expect(model.managed).toEqual({
          selectable: false,
          reason: "price_unconfirmed",
        });
        expect(
          await t.service.confirmPrice(ADMIN, {
            ...SONNET,
            referenceHash: model.price.reference.hash,
          }),
        ).toEqual({ ok: false, code: "price_missing" });
      },
    );

    // #549-T13
    it_(
      "counts a confirmation of the first hash version as stale until it is confirmed again",
      async () => {
        const t = await setup();
        const shown = await view(t);
        await t.confirmations.append(
          {
            providerId: "anthropic",
            modelId: "claude-sonnet-5-5",
            source: "catalog",
            book: parsedBook(shown.price.book) as PriceBook,
            reference: parsedBook(shown.price.reference.book),
            // What the first version wrote: the bare digest.
            referenceHash: shown.price.reference.hash.replace(/^v2:/, ""),
            reason: null,
            confirmedBy: ADMIN,
          },
          T1,
        );

        const old = await view(t);
        expect(old.price.status).toBe("stale");
        expect(old.managed).toMatchObject({ selectable: false });

        const again = await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: old.price.reference.hash,
        });
        expect(again).toMatchObject({
          ok: true,
          model: { price: { status: "confirmed" } },
        });
        expect(
          await t.confirmations.history("anthropic", "claude-sonnet-5-5"),
        ).toHaveLength(2);
      },
    );

    // #549-T05
    it_(
      "keeps the confirmation when the daily fetch changes nothing about the price",
      async () => {
        const t = await setup();
        await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: (await view(t)).price.reference.hash,
        });

        await t.fetchChanged((body) => {
          body.anthropic!.models["claude-sonnet-5-5"]!.name =
            "Claude Sonnet 5.5 (renamed)";
        });

        expect((await view(t)).price.status).toBe("confirmed");
      },
    );

    // #548-T11
    it_(
      "keeps the confirmation of a model models.dev no longer lists",
      async () => {
        const t = await setup();
        await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: (await view(t)).price.reference.hash,
        });
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });

        await t.fetchChanged((body) => {
          delete body.anthropic!.models["claude-sonnet-5-5"];
        });

        const model = await view(t);
        expect(model.listed).toBe(false);
        expect(model.price.status).toBe("confirmed");
        expect(model.managed).toMatchObject({ selectable: true });
      },
    );
  });

  describe("selection on the managed key", () => {
    // #549-T07
    it_(
      "selects a model only when it is enabled and its price is confirmed",
      async () => {
        const t = await setup();
        const hash = async () => (await view(t)).price.reference.hash;

        expect(
          await t.service.availability("anthropic", "claude-sonnet-5-5"),
        ).toEqual({
          selectable: false,
          reason: "model_not_enabled",
          code: "catalog_model_unavailable",
        });
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });
        expect(
          await t.service.availability("anthropic", "claude-sonnet-5-5"),
        ).toEqual({
          selectable: false,
          reason: "price_unconfirmed",
          code: "catalog_price_unconfirmed",
        });
        await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: await hash(),
        });
        const open = await t.service.availability(
          "anthropic",
          "claude-sonnet-5-5",
        );
        expect(open).toMatchObject({ selectable: true });
        expect(open.selectable && open.book.output).toBe("10000000");
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: false });
        expect(
          await t.service.availability("anthropic", "claude-sonnet-5-5"),
        ).toEqual({
          selectable: false,
          reason: "model_not_enabled",
          code: "catalog_model_unavailable",
        });
      },
    );

    // #549-T07
    it_(
      "answers in a form that survives JSON: prices as decimal strings, with the confirmation and the hash version",
      async () => {
        const t = await setup();
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });
        await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: (await view(t)).price.reference.hash,
        });
        const confirmation = (await view(t)).price.confirmation;

        const answer = await t.service.availability(
          "anthropic",
          "claude-sonnet-5-5",
        );

        expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
        expect(answer).toMatchObject({
          selectable: true,
          confirmationId: confirmation?.id,
          hashVersion: 2,
          book: { input: "2000000", output: "10000000", cacheWrite1h: null },
        });
      },
    );

    // #549-T07
    it_("refuses with the stable code of an unconfirmed price", async () => {
      const t = await setup();
      await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });

      expect(
        await t.service.availability("anthropic", "claude-sonnet-5-5"),
      ).toEqual({
        selectable: false,
        reason: "price_unconfirmed",
        code: "catalog_price_unconfirmed",
      });
    });

    // #549-T07
    it_(
      "counts a database that cannot be read as a refusal with a stable code, not a throw, and logs no detail",
      async () => {
        const t = await setup();
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });
        await t.db.destroy();

        const answer = await t.service.availability(
          "anthropic",
          "claude-sonnet-5-5",
        );

        expect(answer).toEqual({
          selectable: false,
          reason: "check_failed",
          code: "catalog_model_unavailable",
        });
        expect(t.errors).toEqual([
          "model prices: AVAILABILITY_CHECK_FAILED: the managed key is refused for this model.",
        ]);
      },
    );

    // #549-T07
    it_(
      "stops selecting a model whose price changed after the confirmation",
      async () => {
        const t = await setup();
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });
        await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: (await view(t)).price.reference.hash,
        });
        await t.fetchChanged((body) => {
          body.anthropic!.models["claude-sonnet-5-5"]!.cost = {
            input: 2.2,
            output: 10,
            cache_read: 0.1,
            cache_write: 2.5,
          };
        });

        expect(
          await t.service.availability("anthropic", "claude-sonnet-5-5"),
        ).toEqual({
          selectable: false,
          reason: "price_unconfirmed",
          code: "catalog_price_unconfirmed",
        });
      },
    );

    // #549-T07
    it_(
      "answers model_unknown for a model the catalog does not have",
      async () => {
        const t = await setup();

        expect(await t.service.availability("anthropic", "nobody")).toEqual({
          selectable: false,
          reason: "model_unknown",
          code: "catalog_model_unavailable",
        });
      },
    );

    // #548-T08
    it_(
      "stops selecting a model of a provider whose address changed, until an admin confirms the address",
      async () => {
        const t = await setup();
        await t.service.setEnabled(ADMIN, { ...DEEPSEEK, enabled: true });
        await t.service.confirmPrice(ADMIN, {
          ...DEEPSEEK,
          referenceHash: (await view(t, DEEPSEEK)).price.reference.hash,
        });
        expect(
          await t.service.availability("deepseek", "deepseek-v4-pro"),
        ).toMatchObject({ selectable: true });

        await t.fetchChanged((body) => {
          body.deepseek!.api = "https://api.deepseek.moved.example/v1";
        });

        expect(
          await t.service.availability("deepseek", "deepseek-v4-pro"),
        ).toEqual({
          selectable: false,
          reason: "provider_url_blocked",
          code: "catalog_model_unavailable",
        });
      },
    );
  });

  describe("the audit", () => {
    // #549-T09
    it_(
      "writes one line for each write, with the person, the model and the old and new price",
      async () => {
        const t = await setup();
        await t.service.setEnabled(ADMIN, { ...SONNET, enabled: true });
        await t.service.confirmPrice(ADMIN, {
          ...SONNET,
          referenceHash: (await view(t)).price.reference.hash,
        });
        const shown = await view(t);
        await t.service.correctPrice("admin-2", {
          ...SONNET,
          referenceHash: shown.price.reference.hash,
          price: { ...shown.price.book, input: "2500000" },
          reason: "Invoice of October.",
        });

        expect(t.lines).toHaveLength(3);
        expect(t.lines[0]).toBe(
          `model prices: MODEL_ENABLED by=${ADMIN} model=anthropic/claude-sonnet-5-5`,
        );
        expect(t.lines[1]).toContain(
          `PRICE_CONFIRMED by=${ADMIN} model=anthropic/claude-sonnet-5-5 source=catalog`,
        );
        expect(t.lines[1]).toContain("old=none");
        expect(t.lines[1]).toContain('"input":"2000000"');
        expect(t.lines[2]).toContain(
          "PRICE_CORRECTED by=admin-2 model=anthropic/claude-sonnet-5-5",
        );
        expect(t.lines[2]).toContain('old={"input":"2000000"');
        expect(t.lines[2]).toContain('"input":"2500000"');
        expect(t.lines[2]).toContain('reason="Invoice of October."');
      },
    );

    // #549-T09
    it_(
      "writes no line for a refused write, and keeps a reason with a line break out of the log",
      async () => {
        const t = await setup();
        await t.service.setEnabled(ADMIN, {
          providerId: "anthropic",
          modelId: "nobody",
          enabled: true,
        });
        const shown = await view(t);
        await t.service.correctPrice(ADMIN, {
          ...SONNET,
          referenceHash: shown.price.reference.hash,
          price: shown.price.book,
          reason: "line one\nline two",
        });
        expect(t.lines).toEqual([]);

        await t.service.correctPrice(ADMIN, {
          ...SONNET,
          referenceHash: shown.price.reference.hash,
          price: shown.price.book,
          reason: 'He said "ok" <b>',
        });
        expect(t.lines).toHaveLength(1);
        expect(t.lines[0]).not.toContain("\n");
      },
    );
  });

  describe("a confirmation and the daily fetch", () => {
    // #549-T05
    it_(
      "waits for a fetch that is writing and then refuses a price the admin did not see",
      async () => {
        const t = await setup();
        const seen = (await view(t)).price.reference.hash;
        const moved = t.body();
        moved.anthropic!.models["claude-sonnet-5-5"]!.cost = {
          input: 2.2,
          output: 10,
          cache_read: 0.1,
          cache_write: 2.5,
        };

        // What the fetch does: lock the provider rows, then write the model's new price in the same transaction.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let written!: () => void;
        const hasWritten = new Promise<void>((resolve) => (written = resolve));
        const fetching = t.db.transaction().execute(async (trx) => {
          await createModelsDevRepository(trx).listProviders({
            forUpdate: true,
          });
          const row = await createModelsDevRepository(trx).getModel(
            "anthropic",
            "claude-sonnet-5-5",
          );
          await createModelsDevRepository(trx).apply({
            providers: [],
            models: [
              {
                ...row!,
                cost: {
                  input: "2.2",
                  output: "10",
                  cacheRead: "0.1",
                  cacheWrite: "2.5",
                },
              },
            ],
          });
          written();
          await gate;
        });
        await hasWritten;

        let settled = false;
        const confirming = t.service
          .confirmPrice(ADMIN, { ...SONNET, referenceHash: seen })
          .finally(() => (settled = true));
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        release();
        await fetching;
        const result = await confirming;

        expect(result).toMatchObject({ ok: false, code: "price_changed" });
        expect((await view(t)).price.status).toBe("unconfirmed");
      },
    );

    // #549-T05
    it_(
      "is never confirmed at a price other than the one confirmed, whichever of a confirmation and a fetch comes first",
      async () => {
        const t = await setup();
        const seen = (await view(t)).price.reference.hash;
        const moved = t.body();
        moved.anthropic!.models["claude-sonnet-5-5"]!.cost = {
          input: 2.2,
          output: 10,
          cache_read: 0.1,
          cache_write: 2.5,
        };
        t.fake.respondWith(moved);
        t.advance(DAY);

        const [confirmation, fetch] = await Promise.all([
          t.service.confirmPrice(ADMIN, { ...SONNET, referenceHash: seen }),
          t.modelsDev.refresh({ acceptLargeChange: true }),
        ]);

        expect(fetch).toMatchObject({ status: "applied" });
        const model = await view(t);
        expect(model.price.reference.book?.input).toBe("2200000");
        if (confirmation.ok) {
          // The confirmation came first: it is kept, and it is stale because the fetch moved the price after it.
          expect(model.price.status).toBe("stale");
          expect(model.price.confirmation?.reference?.input).toBe("2000000");
        } else {
          // The fetch came first: the admin is told the price changed and nothing was written.
          expect(confirmation).toMatchObject({ code: "price_changed" });
          expect(model.price.status).toBe("unconfirmed");
        }
      },
    );
  });
});
