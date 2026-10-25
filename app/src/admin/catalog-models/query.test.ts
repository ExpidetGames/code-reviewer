// SPDX-License-Identifier: LicenseRef-Proprietary

// The filters of the catalog page live in its address (#554): what is read from it, what is dropped, how it becomes the
// query of the service (one page of 50), and the address of the next page.
import { describe, expect, it } from "vitest";
import { parseListQuery } from "../../model-prices/admin-http.ts";
import {
  PAGE_SIZE,
  catalogHref,
  listQueryOf,
  parseCatalogQuery,
} from "./query.ts";

describe("the filters of the catalog page", () => {
  // #554-T01
  it("reads the provider, the search, the price status, the state and the page from the address", () => {
    expect(
      parseCatalogQuery({
        provider: "deepseek",
        q: " v4 ",
        price: "stale",
        state: "new",
        page: "3",
      }),
    ).toEqual({
      provider: "deepseek",
      search: "v4",
      priceStatus: "stale",
      state: "new",
      page: 3,
    });
  });

  // #554-T01
  it("drops what the page does not offer instead of passing it on", () => {
    expect(
      parseCatalogQuery({
        provider: "",
        q: "  ",
        price: "free",
        state: "maybe",
        page: "0",
        other: "x",
      }),
    ).toEqual({ page: 1 });
    expect(parseCatalogQuery({ page: "-2" }).page).toBe(1);
    expect(parseCatalogQuery({ page: "1e3" }).page).toBe(1);
    expect(parseCatalogQuery({ provider: "x".repeat(201) })).toEqual({
      page: 1,
    });
    expect(parseCatalogQuery({ q: "y".repeat(300) }).search).toHaveLength(200);
    expect(
      parseCatalogQuery({ price: ["stale", "unpriced"] }).priceStatus,
    ).toBe("stale");
  });

  // #554-T01
  it("asks the service for one page of 50 of the filtered, newest-first list", () => {
    expect(listQueryOf({ page: 1 })).toEqual({ limit: PAGE_SIZE, offset: 0 });
    expect(listQueryOf({ page: 3 })).toEqual({ limit: 50, offset: 100 });
    expect(
      listQueryOf({
        provider: "deepseek",
        search: "v4",
        priceStatus: "unconfirmed",
        state: "disabled",
        page: 2,
      }),
    ).toEqual({
      provider: "deepseek",
      search: "v4",
      priceStatus: "unconfirmed",
      enabled: "no",
      limit: 50,
      offset: 50,
    });
    expect(listQueryOf({ state: "new", page: 1 })).toMatchObject({
      onlyNew: true,
    });
    expect(listQueryOf({ state: "enabled", page: 1 })).toMatchObject({
      enabled: "yes",
    });
    expect(listQueryOf({ state: "undecided", page: 1 })).toMatchObject({
      enabled: "undecided",
    });
  });

  // #554-T01
  it("makes a query the route of the list accepts", () => {
    const query = listQueryOf({
      provider: "deepseek",
      search: "v4",
      priceStatus: "stale",
      state: "new",
      page: 2,
    });
    const params = new URLSearchParams({
      provider: "deepseek",
      search: "v4",
      priceStatus: "stale",
      new: "true",
      limit: String(query.limit),
      offset: String(query.offset),
    });

    expect(
      parseListQuery(new URL(`https://x.test/?${params.toString()}`)),
    ).toMatchObject({
      ok: true,
    });
  });

  // #554-T01
  it("writes an address that reads back as the same query", () => {
    const query = {
      provider: "open router",
      search: "a&b=c",
      priceStatus: "stale" as const,
      state: "enabled" as const,
      page: 4,
    };

    const href = catalogHref(query);

    expect(href.startsWith("/admin/catalog?")).toBe(true);
    const params = Object.fromEntries(
      new URL(href, "https://x.test").searchParams,
    );
    expect(parseCatalogQuery(params)).toEqual(query);
    expect(catalogHref({ page: 1 })).toBe("/admin/catalog");
  });
});
