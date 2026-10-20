// SPDX-License-Identifier: Apache-2.0

// The cost policy a claim hands a native job (#553): pure decisions from what the price service answers.
import { describe, expect, it } from "vitest";
import type { ManagedAvailabilityJson } from "../model-prices/availability.ts";
import type { PriceBookJson } from "../model-prices/price-book.ts";
import { managedPolicy, ownPolicy } from "./policy.ts";

const LEVEL = {
  input: "3000000",
  output: "15000000",
  cacheRead: "300000",
  cacheWrite5m: "3750000",
  cacheWrite1h: "6000000",
  reasoning: null,
  inputAudio: null,
  outputAudio: null,
};
const BOOK: PriceBookJson = { ...LEVEL, contextOver200k: null, tiers: [] };
const selectable = (book: PriceBookJson): ManagedAvailabilityJson => ({
  selectable: true,
  book,
  confirmationId: 7,
  hashVersion: 2,
});

describe("the managed key's policy", () => {
  // #553-T02
  it("carries the confirmed book and no token cap", () => {
    expect(managedPolicy(selectable(BOOK))).toEqual({
      ok: true,
      policy: { keyMode: "managed", priceBook: BOOK, maxTotalTokens: null },
    });
  });

  // #553-T01
  it("refuses a model that is not selectable with the code the price service gave", () => {
    expect(
      managedPolicy({
        selectable: false,
        reason: "price_unconfirmed",
        code: "catalog_price_unconfirmed",
      }),
    ).toEqual({
      ok: false,
      code: "catalog_price_unconfirmed",
      reason: "price_unconfirmed",
    });
    expect(
      managedPolicy({
        selectable: false,
        reason: "check_failed",
        code: "catalog_model_unavailable",
      }),
    ).toEqual({
      ok: false,
      code: "catalog_model_unavailable",
      reason: "check_failed",
    });
  });

  // #553-R04
  it("refuses a book that sells a cache write and states no cache read: a read would be billed at a price nobody confirmed", () => {
    for (const change of [
      { cacheRead: null },
      { cacheRead: null, cacheWrite1h: null },
      { cacheRead: null, cacheWrite5m: null },
    ])
      expect(managedPolicy(selectable({ ...BOOK, ...change }))).toEqual({
        ok: false,
        code: "catalog_price_unconfirmed",
        reason: "cache_read_unpriced",
      });
  });

  // #553-R04
  it("refuses a tier that drops the cache read the base level states", () => {
    const tier = {
      ...LEVEL,
      cacheRead: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
    };
    expect(
      managedPolicy(
        selectable({ ...BOOK, tiers: [{ contextOver: 200_000, ...tier }] }),
      ),
    ).toMatchObject({ ok: false, reason: "cache_read_unpriced" });
    expect(
      managedPolicy(selectable({ ...BOOK, contextOver200k: tier })),
    ).toMatchObject({ ok: false, reason: "cache_read_unpriced" });
  });

  // #553-R04
  it("accepts a model with no cache prices at all: nothing says it offers a cache read", () => {
    const plain: PriceBookJson = {
      ...BOOK,
      cacheRead: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
    };
    expect(managedPolicy(selectable(plain)).ok).toBe(true);
  });
});

describe("the own key's policy", () => {
  // #553-T05
  it("has the token cap and no book for a model nobody priced", () => {
    expect(ownPolicy(null, 4_000_000)).toEqual({
      keyMode: "own",
      priceBook: null,
      maxTotalTokens: 4_000_000,
    });
  });

  // #553-T04
  it("carries the price the catalog states, and the cap", () => {
    expect(ownPolicy(BOOK, 2_000_000)).toEqual({
      keyMode: "own",
      priceBook: BOOK,
      maxTotalTokens: 2_000_000,
    });
  });
});
