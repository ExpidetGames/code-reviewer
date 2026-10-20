// SPDX-License-Identifier: Apache-2.0

// The calls the catalog screens make to the portal's own data routes (src/model-prices/admin-http.ts and
// src/models-dev/admin-http.ts). Browser side; nothing throws, a failure is a stable code the page translates
// (messages.ts). The bodies are exactly the documented ones: a price is sent as whole micro-USD digit strings.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { CatalogModelView } from "../../model-prices/admin-view.ts";
import type { PriceBookJson } from "../../model-prices/price-book.ts";
import type { ProviderView } from "../../models-dev/admin-service.ts";
import type { FetchSummary } from "../../models-dev/catalog.ts";

export type ModelIds = { providerId: string; modelId: string };

export type ModelChanged = { ok: true; model: CatalogModelView };
export type ProviderChanged = { ok: true; provider: ProviderView };
export type FetchApplied = {
  ok: true;
  outcome: "applied";
  summary: FetchSummary;
};

export type CatalogModelsApi = {
  /** Enables or disables a model for the managed key. */
  setEnabled(
    ids: ModelIds,
    enabled: boolean,
  ): Promise<RequestResult<ModelChanged>>;
  /** Takes the decision back, so the model is "new" again. */
  resetDecision(ids: ModelIds): Promise<RequestResult<ModelChanged>>;
  /** Confirms the reference price the admin saw (its hash, as it is). */
  confirmPrice(
    ids: ModelIds,
    referenceHash: string,
  ): Promise<RequestResult<ModelChanged>>;
  /** States the price, against the reference the admin saw, with a reason. */
  correctPrice(
    ids: ModelIds,
    referenceHash: string,
    price: PriceBookJson,
    reason: string,
  ): Promise<RequestResult<ModelChanged>>;
  /** Trusts the address the admin saw. */
  confirmUrl(input: {
    providerId: string;
    pendingUrl: string;
  }): Promise<RequestResult<ProviderChanged>>;
  /** Fetches the catalog now; `acceptLargeChange` applies a fetch the guard refused, after the admin looked at it. */
  fetchNow(options?: {
    acceptLargeChange: true;
  }): Promise<RequestResult<FetchApplied>>;
};

const MODELS = "/api/admin/catalog-models";
const PROVIDERS = "/api/admin/catalog-providers";

export function createCatalogModelsApi(fetchImpl: FetchLike): CatalogModelsApi {
  return {
    setEnabled: (ids, enabled) =>
      requestJson(fetchImpl, "POST", `${MODELS}/enablement`, {
        providerId: ids.providerId,
        modelId: ids.modelId,
        enabled,
      }),
    resetDecision: (ids) =>
      requestJson(fetchImpl, "POST", `${MODELS}/enablement/reset`, {
        providerId: ids.providerId,
        modelId: ids.modelId,
      }),
    confirmPrice: (ids, referenceHash) =>
      requestJson(fetchImpl, "POST", `${MODELS}/price/confirm`, {
        providerId: ids.providerId,
        modelId: ids.modelId,
        referenceHash,
      }),
    correctPrice: (ids, referenceHash, price, reason) =>
      requestJson(fetchImpl, "POST", `${MODELS}/price/correct`, {
        providerId: ids.providerId,
        modelId: ids.modelId,
        referenceHash,
        price,
        reason,
      }),
    confirmUrl: ({ providerId, pendingUrl }) =>
      requestJson(fetchImpl, "POST", `${PROVIDERS}/url/confirm`, {
        providerId,
        pendingUrl,
      }),
    fetchNow: (options) =>
      requestJson(
        fetchImpl,
        "POST",
        "/api/admin/catalog-fetch",
        options?.acceptLargeChange === true ? { acceptLargeChange: true } : {},
      ),
  };
}

export const browserCatalogModelsApi = createCatalogModelsApi((url, init) =>
  fetch(url, init),
);
