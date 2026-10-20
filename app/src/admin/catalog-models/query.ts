// SPDX-License-Identifier: Apache-2.0

// The filters of the catalog page (#554) live in its address, so a search can be shared, the back button works, and the
// server renders the page it was asked for: there are 200 providers and thousands of models, so the page lists one filtered
// page of 50 at a time instead of everything. Values the page does not offer are dropped, never passed on. Client safe.
import type { PriceStatus } from "../../model-prices/effective-price.ts";
import type { ListQuery } from "../../model-prices/service.ts";
import { PRICE_STATUS_ORDER } from "./messages.ts";

export const CATALOG_PATH = "/admin/catalog";
export const PAGE_SIZE = 50;
export const STATE_FILTERS = [
  "new",
  "enabled",
  "disabled",
  "undecided",
] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

export type CatalogQuery = {
  provider?: string;
  search?: string;
  priceStatus?: PriceStatus;
  state?: StateFilter;
  /** From 1. */
  page: number;
};

type Params = Readonly<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseCatalogQuery(params: Params): CatalogQuery {
  const query: CatalogQuery = { page: 1 };
  const provider = first(params.provider)?.trim();
  if (provider !== undefined && provider !== "" && provider.length <= 200)
    query.provider = provider;
  const search = first(params.q)?.trim();
  if (search !== undefined && search !== "")
    query.search = search.slice(0, 200);
  const price = PRICE_STATUS_ORDER.find((s) => s === first(params.price));
  if (price !== undefined) query.priceStatus = price;
  const state = STATE_FILTERS.find((s) => s === first(params.state));
  if (state !== undefined) query.state = state;
  const page = first(params.page);
  if (page !== undefined && /^\d{1,6}$/.test(page) && Number(page) >= 1)
    query.page = Number(page);
  return query;
}

/** The query of the service for one page of the filtered list. */
export function listQueryOf(query: CatalogQuery): ListQuery {
  const list: ListQuery = {
    limit: PAGE_SIZE,
    offset: (query.page - 1) * PAGE_SIZE,
  };
  if (query.provider !== undefined) list.provider = query.provider;
  if (query.search !== undefined) list.search = query.search;
  if (query.priceStatus !== undefined) list.priceStatus = query.priceStatus;
  if (query.state === "new") list.onlyNew = true;
  if (query.state === "enabled") list.enabled = "yes";
  if (query.state === "disabled") list.enabled = "no";
  if (query.state === "undecided") list.enabled = "undecided";
  return list;
}

/** The address of the page for a query (page 1 leaves out `page`). */
export function catalogHref(query: CatalogQuery): string {
  const search = new URLSearchParams();
  if (query.provider !== undefined) search.set("provider", query.provider);
  if (query.search !== undefined) search.set("q", query.search);
  if (query.priceStatus !== undefined) search.set("price", query.priceStatus);
  if (query.state !== undefined) search.set("state", query.state);
  if (query.page > 1) search.set("page", String(query.page));
  const text = search.toString();
  return text === "" ? CATALOG_PATH : `${CATALOG_PATH}?${text}`;
}
