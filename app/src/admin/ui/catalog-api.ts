// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the catalog section makes to its own data routes (src/model-catalog/admin-http.ts). Browser side; nothing
// throws, a failure is a stable code the page translates (catalog-messages.ts).
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type {
  AdminCatalogEntry,
  AdminCatalogView,
} from "../../model-catalog/admin-view.ts";
import type { CatalogDefaults } from "../../model-catalog/entries.ts";
import type { ProjectReviewKind } from "../../review-settings/settings.ts";

/** What the form sends for an entry. */
export type EntryInput = {
  name: string;
  description: string | null;
  provider: string;
  modelId: string;
  kinds: ProjectReviewKind[];
};

/** What the server answers to a change: the catalog as it is now, and the entry that was changed. */
export type CatalogChanged = {
  ok: true;
  catalog: AdminCatalogView;
  entry?: AdminCatalogEntry;
  modelChange?: { projects: number } | null;
};

/** The result of "Check model": the provider vouches for the model, or a stable code says why not. */
export type CheckAnswer =
  { ok: true; verified: boolean } | { ok: false; error: string };

export type CatalogApi = {
  create(input: EntryInput): Promise<RequestResult<CatalogChanged>>;
  /**
   * Changes the given fields. `confirmModelChange` is set only after the admin confirmed that the model behind a released
   * entry changes; without it the server refuses such a change.
   */
  update(
    id: string,
    input: Partial<EntryInput> & {
      sortOrder?: number;
      confirmModelChange?: true;
    },
  ): Promise<RequestResult<CatalogChanged>>;
  release(id: string): Promise<RequestResult<CatalogChanged>>;
  retire(id: string): Promise<RequestResult<CatalogChanged>>;
  remove(id: string): Promise<RequestResult<CatalogChanged>>;
  /** Puts the entries in the given order, every entry's id once, first to last: one request, all or nothing. */
  reorder(order: string[]): Promise<RequestResult<CatalogChanged>>;
  setDefaults(
    defaults: CatalogDefaults,
  ): Promise<RequestResult<CatalogChanged>>;
  /** Asks the provider's metadata what release would ask; nothing is stored. */
  check(input: {
    provider: string;
    modelId: string;
    kinds: ProjectReviewKind[];
  }): Promise<RequestResult<CheckAnswer>>;
};

const BASE = "/api/admin/model-catalog";

export function createCatalogApi(fetchImpl: FetchLike): CatalogApi {
  const entry = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
  return {
    create: (input) => requestJson(fetchImpl, "POST", BASE, input),
    update: (id, input) => requestJson(fetchImpl, "PUT", entry(id), input),
    release: (id) => requestJson(fetchImpl, "POST", `${entry(id)}/release`, {}),
    retire: (id) => requestJson(fetchImpl, "POST", `${entry(id)}/retire`, {}),
    remove: (id) => requestJson(fetchImpl, "DELETE", entry(id), {}),
    reorder: (order) =>
      requestJson(fetchImpl, "PUT", `${BASE}/order`, { order }),
    setDefaults: (defaults) =>
      requestJson(fetchImpl, "PUT", `${BASE}/defaults`, defaults),
    check: (input) => requestJson(fetchImpl, "POST", `${BASE}/check`, input),
  };
}

export const browserCatalogApi = createCatalogApi((url, init) =>
  fetch(url, init),
);
