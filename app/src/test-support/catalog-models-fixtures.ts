// SPDX-License-Identifier: Apache-2.0

// Catalog models, providers and lists as the admin screens receive them (#554), for the component tests: dummy names,
// prices as whole micro-USD strings, the shapes of src/model-prices/admin-view.ts and src/models-dev/admin-service.ts.
import type { CatalogModelView } from "../model-prices/admin-view.ts";
import type { PriceSources } from "../model-prices/effective-price.ts";
import type { PriceBookJson } from "../model-prices/price-book.ts";
import type { ModelList } from "../model-prices/service.ts";
import type { ProviderView } from "../models-dev/admin-service.ts";
import type { FetchState } from "../models-dev/catalog.ts";

export const AT = "2026-10-20T08:00:00.000Z";

export function book(
  input: string,
  output: string,
  more: Partial<PriceBookJson> = {},
): PriceBookJson {
  return {
    input,
    output,
    cacheRead: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: null,
    inputAudio: null,
    outputAudio: null,
    contextOver200k: null,
    tiers: [],
    ...more,
  };
}

export const CATALOG_SOURCES: PriceSources = {
  input: "catalog",
  output: "catalog",
  cacheRead: "catalog",
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: null,
  inputAudio: null,
  outputAudio: null,
  contextOver200k: null,
  tiers: null,
};

export const TODAY = book("600000", "1200000", { cacheRead: "60000" });

export function model(
  changes: Partial<CatalogModelView> = {},
): CatalogModelView {
  return {
    providerId: "deepseek",
    providerName: "DeepSeek",
    modelId: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    limit: { context: 1000000, output: 384000 },
    reasoning: true,
    upstreamStatus: null,
    listed: true,
    unlistedAt: null,
    firstSeenAt: AT,
    isNew: false,
    providerUrl: "trusted",
    enabled: null,
    enablement: null,
    price: {
      status: "unconfirmed",
      warnings: [],
      book: TODAY,
      sources: CATALOG_SOURCES,
      reference: {
        book: TODAY,
        hash: "v2:abc123",
        sources: CATALOG_SOURCES,
      },
      confirmation: null,
    },
    override: null,
    managed: { selectable: false, reason: "model_not_enabled" },
    ...changes,
  };
}

/** A model whose price was confirmed at `old` and is `now` since (null: the catalog states none any more). */
export function staleModelBetween(
  old: PriceBookJson,
  now: PriceBookJson | null,
): CatalogModelView {
  return model({
    price: {
      status: "stale",
      warnings: [],
      book: old,
      sources: CATALOG_SOURCES,
      reference: { book: now, hash: "v2:newhash", sources: CATALOG_SOURCES },
      confirmation: {
        id: 1,
        source: "catalog",
        book: old,
        reference: old,
        reason: null,
        confirmedBy: "admin-1",
        confirmedAt: AT,
      },
    },
    enabled: true,
    managed: { selectable: false, reason: "price_unconfirmed" },
  });
}

/** A model whose price was confirmed at 0.50 / 1.00 and has moved to `TODAY` since. */
export function staleModel(): CatalogModelView {
  return staleModelBetween(
    book("500000", "1000000", { cacheRead: "50000" }),
    TODAY,
  );
}

export function provider(changes: Partial<ProviderView> = {}): ProviderView {
  return {
    id: "deepseek",
    name: "DeepSeek",
    listed: true,
    url: {
      state: "trusted",
      trustedUrl: "https://api.deepseek.com",
      pendingUrl: null,
      problem: null,
    },
    urlChangedAt: null,
    models: 1,
    ...changes,
  };
}

export const FETCH_OK: FetchState = {
  lastAttemptAt: "2026-10-20T03:00:00.000Z",
  lastSuccessAt: "2026-10-20T03:00:00.000Z",
  lastStatus: "ok",
  lastError: null,
  lastSummary: {
    models: 13,
    newModels: 2,
    changedModels: 1,
    unlistedModels: 0,
  },
};

export function list(
  models: CatalogModelView[],
  changes: Partial<ModelList> = {},
): ModelList {
  return {
    models,
    total: models.length,
    newCount: models.filter((m) => m.isNew).length,
    fetch: FETCH_OK,
    ...changes,
  };
}
