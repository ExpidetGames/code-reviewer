// SPDX-License-Identifier: Apache-2.0

// Whether the managed key, which we pay, may use a model (#549, #553): the admin enabled it, the price is confirmed (and
// still is), the provider's address is trusted, and the override file does not block or retire it. Pure.
import { describe, expect, it } from "vitest";
import type { StoredModel, StoredProvider } from "../models-dev/catalog.ts";
import { managedAvailability } from "./availability.ts";
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
    referenceHash: referenceHash(reference),
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
    expect(result.book.input).toBe(600_000n);
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
