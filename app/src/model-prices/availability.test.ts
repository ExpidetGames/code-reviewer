// SPDX-License-Identifier: LicenseRef-Proprietary

// Whether the managed key, which we pay, may use a model (#549, #553): the admin enabled it, the price is confirmed (and
// still is), the provider's address is trusted, and the override file does not block or retire it. Pure.
import { describe, expect, it } from "vitest";
import type { StoredModel, StoredProvider } from "../models-dev/catalog.ts";
import {
  MANAGED_UNAVAILABLE_REASONS,
  managedAvailability,
  managedAvailabilityToJson,
} from "./availability.ts";
import type { PriceConfirmation } from "./confirmation.ts";
import { effectivePrice } from "./effective-price.ts";
import type { ModelOverride } from "./overrides.ts";
import { priceBookFromCatalog, type PriceBook } from "./price-book.ts";
import { referenceHash } from "./price-hash.ts";

const NOW = new Date("2026-10-20T12:00:00.000Z");

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
  firstSeenAt: "2026-10-19T03:00:00.000Z",
  unlistedAt: null,
  updatedAt: "2026-10-19T03:00:00.000Z",
};

const model: StoredModel = {
  providerId: "deepseek",
  id: "deepseek-v4-pro",
  name: "DeepSeek V4 Pro",
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
  firstSeenAt: "2026-10-19T03:00:00.000Z",
  unlistedAt: null,
  updatedAt: "2026-10-19T03:00:00.000Z",
};

function confirmed(cost = model.cost): PriceConfirmation {
  const reference = priceBookFromCatalog(cost, undefined) as PriceBook;
  return {
    id: 1,
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    source: "catalog",
    book: reference,
    reference,
    referenceHash: referenceHash(reference, { reasoning: false }),
    reason: null,
    confirmedBy: "admin-1",
    confirmedAt: "2026-10-20T09:00:00.000Z",
  };
}

function check(
  patch: {
    provider?: StoredProvider | undefined;
    model?: StoredModel | undefined;
    enabled?: boolean;
    confirmation?: PriceConfirmation | null;
    override?: ModelOverride | undefined;
  } = {},
) {
  const row = "model" in patch ? patch.model : model;
  const override = patch.override;
  return managedAvailability({
    provider: "provider" in patch ? patch.provider : provider,
    model: row,
    enabled: patch.enabled ?? true,
    override,
    price: effectivePrice({
      reasoning: false,
      cost: row?.cost ?? null,
      override,
      confirmation:
        "confirmation" in patch ? (patch.confirmation ?? null) : confirmed(),
    }),
    now: NOW,
  });
}

describe("managedAvailability", () => {
  // #549-T07
  it("selects a model that is enabled and has a confirmed price, and hands out that price", () => {
    const result = check();

    expect(result).toMatchObject({ selectable: true });
    if (!result.selectable) return;
    expect(result.book.input).toBe(BigInt(600_000));
  });

  // #549-T07
  it("does not select a model the admin has not enabled, or has disabled", () => {
    expect(check({ enabled: false })).toEqual({
      selectable: false,
      reason: "model_not_enabled",
    });
  });

  // #549-T07
  it.each([
    ["never confirmed", { confirmation: null }],
    [
      "confirmed and then changed",
      {
        model: {
          ...model,
          cost: { input: "0.7", output: "1.2", cacheRead: "0.06" },
        },
      },
    ],
    ["not priced", { model: { ...model, cost: null }, confirmation: null }],
  ])("does not select a model whose price is %s", (_name, patch) => {
    expect(check(patch)).toEqual({
      selectable: false,
      reason: "price_unconfirmed",
    });
  });

  // #549-T07
  it("does not select a model that is not in the catalog", () => {
    expect(check({ model: undefined })).toEqual({
      selectable: false,
      reason: "model_unknown",
    });
    expect(check({ provider: undefined })).toEqual({
      selectable: false,
      reason: "model_unknown",
    });
  });

  // #548-T08
  it("does not select a model of a provider whose address is not trusted, or that is not supported", () => {
    expect(
      check({
        provider: {
          ...provider,
          url: {
            state: "url_changed",
            trustedUrl: "https://api.deepseek.com",
            pendingUrl: "https://api.other.example",
            problem: null,
          },
        },
      }),
    ).toEqual({ selectable: false, reason: "provider_url_blocked" });
    expect(
      check({
        provider: { ...provider, id: "amazon-bedrock" },
        model: { ...model, providerId: "amazon-bedrock" },
      }),
    ).toEqual({ selectable: false, reason: "provider_unsupported" });
  });

  // #549-T01
  it("does not select a model the override file blocks, or retires after its date", () => {
    const blocked: ModelOverride = {
      reason: "Wrong tool flag upstream.",
      cacheWrite1h: null,
      retiresNotBefore: null,
      blocked: true,
    };
    const retired: ModelOverride = {
      ...blocked,
      blocked: false,
      retiresNotBefore: "2026-10-19",
    };
    const lastDay: ModelOverride = {
      ...blocked,
      blocked: false,
      retiresNotBefore: "2026-10-20",
    };

    expect(check({ override: blocked })).toEqual({
      selectable: false,
      reason: "model_blocked",
    });
    expect(check({ override: retired })).toEqual({
      selectable: false,
      reason: "model_retired",
    });
    expect(check({ override: lastDay })).toMatchObject({ selectable: true });
  });

  // #548-T11
  it("keeps selecting a model models.dev no longer lists, until the admin disables it", () => {
    expect(
      check({ model: { ...model, unlistedAt: "2026-10-20T03:00:00.000Z" } }),
    ).toMatchObject({ selectable: true });
  });
});

describe("managedAvailabilityToJson", () => {
  // #549-T07
  it("hands out the book as decimal strings with the id of the confirmation and the hash version", () => {
    const result = check();

    const json = managedAvailabilityToJson(result);

    expect(json).toEqual({
      selectable: true,
      confirmationId: 1,
      hashVersion: 2,
      book: expect.objectContaining({
        input: "600000",
        output: "1200000",
        cacheRead: "60000",
      }),
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  // #549-T07
  it("names the stable code of a price that is not confirmed, and one code for every other reason", () => {
    const codes = MANAGED_UNAVAILABLE_REASONS.map((reason) => [
      reason,
      managedAvailabilityToJson({ selectable: false, reason }),
    ]);

    expect(
      Object.fromEntries(
        codes.map(([r, j]) => [r, (j as { code: string }).code]),
      ),
    ).toEqual({
      model_unknown: "catalog_model_unavailable",
      provider_unsupported: "catalog_model_unavailable",
      provider_url_blocked: "catalog_model_unavailable",
      model_entry_invalid: "catalog_model_unavailable",
      model_blocked: "catalog_model_unavailable",
      model_retired: "catalog_model_unavailable",
      model_not_enabled: "catalog_model_unavailable",
      price_unconfirmed: "catalog_price_unconfirmed",
      cache_read_unpriced: "catalog_price_unconfirmed",
      cache_write_unpriced: "catalog_price_unconfirmed",
      check_failed: "catalog_model_unavailable",
    });
  });
});

// #577-L4: one definition of "selectable". A book whose cache price is incomplete is not priced: the runner would have to
// guess the price of a cache read (or write) it meets, and the managed key never runs on a guess.
describe("managedAvailability and the cache prices of the book", () => {
  const NO_CACHE = { input: "0.6", output: "1.2" };
  const anthropic = {
    provider: {
      ...provider,
      id: "anthropic",
      name: "Anthropic",
      url: { ...provider.url, trustedUrl: "https://api.anthropic.com/v1" },
    },
    model: {
      ...model,
      providerId: "anthropic",
      id: "claude-test-1",
      cost: { input: "3", output: "15", cacheRead: "0.3" },
    },
  };

  // #577-L4
  it("does not select a model whose confirmed book states no cache read", () => {
    const row = { ...model, cost: NO_CACHE };

    expect(check({ model: row, confirmation: confirmed(NO_CACHE) })).toEqual({
      selectable: false,
      reason: "cache_read_unpriced",
    });
  });

  // #577-L4
  it("selects it once the admin states the cache read explicitly in a correction", () => {
    const row = { ...model, cost: NO_CACHE };
    const base = confirmed(NO_CACHE);
    const corrected: PriceConfirmation = {
      ...base,
      source: "admin",
      book: { ...base.book, cacheRead: BigInt(600_000) },
    };

    expect(check({ model: row, confirmation: corrected })).toMatchObject({
      selectable: true,
    });
  });

  // #577-L4
  it("does not select a model whose tier drops the cache read the base level states", () => {
    const cost = {
      ...model.cost!,
      tiers: [{ contextOver: 200_000, input: "1.2", output: "2.4" }],
    };
    const row = { ...model, cost };

    expect(check({ model: row, confirmation: confirmed(cost) })).toEqual({
      selectable: false,
      reason: "cache_read_unpriced",
    });
  });

  // #577-L4
  it("does not select a model of the Messages family that states a cache read and no cache write", () => {
    expect(
      check({
        ...anthropic,
        confirmation: {
          ...confirmed(anthropic.model.cost),
          providerId: "anthropic",
          modelId: "claude-test-1",
        },
      }),
    ).toEqual({ selectable: false, reason: "cache_write_unpriced" });
  });

  // #577-L4
  it("selects a model of the Messages family that states both", () => {
    const cost = { ...anthropic.model.cost, cacheWrite: "3.75" };

    expect(
      check({
        provider: anthropic.provider,
        model: { ...anthropic.model, cost },
        confirmation: {
          ...confirmed(cost),
          providerId: "anthropic",
          modelId: "claude-test-1",
        },
      }),
    ).toMatchObject({ selectable: true });
  });
});
