// SPDX-License-Identifier: Apache-2.0

// The price book (#549): what the ledger prices a managed run from, in BigInt micro-USD per million tokens. It is built
// from the models.dev row (decimal strings, tiers) and the override file, and a book an admin types is validated here.
import { describe, expect, it } from "vitest";
import type { ModelCost } from "../models-dev/parse.ts";
import {
  parsePriceBookJson,
  priceBookFromCatalog,
  priceBookToJson,
  type PriceBook,
} from "./price-book.ts";

const COST: ModelCost = {
  input: "0.1",
  output: "0.5",
  cacheRead: "0.01",
  cacheWrite: "0.125",
  tiers: [
    {
      contextOver: 100000,
      input: "0.5",
      output: "2.5",
      cacheRead: "0.05",
      cacheWrite: "0.625",
    },
  ],
};

describe("priceBookFromCatalog", () => {
  // #549-T03
  it("reads the catalog price into micro-USD per million tokens, with cache writes as the 5-minute price", () => {
    const book = priceBookFromCatalog(COST, undefined) as PriceBook;

    expect(book).toEqual({
      input: 100_000n,
      output: 500_000n,
      cacheRead: 10_000n,
      cacheWrite5m: 125_000n,
      cacheWrite1h: null,
      tiers: [
        {
          contextOver: 100000,
          input: 500_000n,
          output: 2_500_000n,
          cacheRead: 50_000n,
          cacheWrite5m: 625_000n,
          cacheWrite1h: null,
        },
      ],
    });
  });

  // #549-T03
  it("takes the 1-hour cache write from the override when the catalog has none", () => {
    const book = priceBookFromCatalog(COST, 200_000n) as PriceBook;

    expect(book.cacheWrite1h).toBe(200_000n);
    expect(book.tiers[0]?.cacheWrite1h).toBeNull();
  });

  // #549-T03
  it("leaves the 1-hour cache write unpriced without an override", () => {
    expect(priceBookFromCatalog(COST, undefined)?.cacheWrite1h).toBeNull();
  });

  it("states a price that is missing as null, not as zero", () => {
    const book = priceBookFromCatalog(
      { input: "1", output: "2" },
      undefined,
    ) as PriceBook;

    expect(book.cacheRead).toBeNull();
    expect(book.cacheWrite5m).toBeNull();
    expect(book.tiers).toEqual([]);
  });

  it("keeps a free model free", () => {
    const book = priceBookFromCatalog(
      { input: "0", output: "0", cacheRead: "0" },
      undefined,
    ) as PriceBook;

    expect(book.input).toBe(0n);
    expect(book.cacheRead).toBe(0n);
  });

  it("has no book for a model the catalog does not price", () => {
    expect(priceBookFromCatalog(null, undefined)).toBeNull();
  });

  it("has no book when a price is finer than a micro-USD, because it cannot be held exactly", () => {
    expect(
      priceBookFromCatalog({ input: "0.0000001", output: "1" }, undefined),
    ).toBeNull();
    expect(
      priceBookFromCatalog(
        {
          input: "1",
          output: "1",
          tiers: [{ contextOver: 10, input: "1", output: "0.0000001" }],
        },
        undefined,
      ),
    ).toBeNull();
  });
});

describe("the JSON form of a book", () => {
  // #549-T04
  it("round-trips, with every amount a decimal string of whole micro-USD", () => {
    const book = priceBookFromCatalog(COST, 200_000n) as PriceBook;

    const json = priceBookToJson(book);

    expect(json).toEqual({
      input: "100000",
      output: "500000",
      cacheRead: "10000",
      cacheWrite5m: "125000",
      cacheWrite1h: "200000",
      tiers: [
        {
          contextOver: 100000,
          input: "500000",
          output: "2500000",
          cacheRead: "50000",
          cacheWrite5m: "625000",
          cacheWrite1h: null,
        },
      ],
    });
    expect(parsePriceBookJson(json)).toEqual({ ok: true, book });
  });

  it("reads the same book from the text a database holds", () => {
    const book = priceBookFromCatalog(COST, undefined) as PriceBook;
    const text = JSON.stringify(priceBookToJson(book));

    expect(parsePriceBookJson(JSON.parse(text))).toEqual({ ok: true, book });
  });
});

describe("parsePriceBookJson", () => {
  const valid = {
    input: "100000",
    output: "500000",
    cacheRead: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    tiers: [],
  };

  it("accepts a book with only input and output", () => {
    expect(parsePriceBookJson({ input: "1", output: "2" })).toMatchObject({
      ok: true,
      book: { input: 1n, output: 2n, cacheRead: null, tiers: [] },
    });
  });

  // #549-T10
  it.each([
    ["a negative amount", { ...valid, input: "-1" }],
    ["NaN", { ...valid, input: "NaN" }],
    ["a number instead of a string", { ...valid, input: 1 }],
    ["a float string", { ...valid, input: "0.5" }],
    ["an exponent", { ...valid, output: "1e6" }],
    ["a missing input", { output: "1" }],
    ["a missing output", { input: "1" }],
    ["an amount above the sanity bound", { ...valid, input: "100000000001" }],
    ["an unknown field", { ...valid, reasoning: "1" }],
    ["a cache price above the bound", { ...valid, cacheRead: "100000000001" }],
    ["null", null],
    ["an array", []],
    ["a string", "1"],
  ])("refuses %s", (_name, input) => {
    expect(parsePriceBookJson(input)).toEqual({ ok: false });
  });

  // #549-T10
  it("refuses a tier that goes backwards or repeats", () => {
    const tier = (contextOver: number) => ({
      contextOver,
      input: "1",
      output: "2",
      cacheRead: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
    });

    expect(
      parsePriceBookJson({ ...valid, tiers: [tier(200000), tier(100000)] }),
    ).toEqual({ ok: false });
    expect(
      parsePriceBookJson({ ...valid, tiers: [tier(100000), tier(100000)] }),
    ).toEqual({ ok: false });
    expect(
      parsePriceBookJson({ ...valid, tiers: [tier(100000), tier(200000)] }),
    ).toMatchObject({ ok: true });
  });

  // #549-T10
  it("refuses a tier with a bad context size, an amount of the wrong kind, or too many tiers", () => {
    const tier = (over: Record<string, unknown>) => ({
      contextOver: 1000,
      input: "1",
      output: "2",
      cacheRead: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      ...over,
    });

    expect(
      parsePriceBookJson({ ...valid, tiers: [tier({ contextOver: 0 })] }),
    ).toEqual({ ok: false });
    expect(
      parsePriceBookJson({ ...valid, tiers: [tier({ contextOver: 1.5 })] }),
    ).toEqual({ ok: false });
    expect(
      parsePriceBookJson({ ...valid, tiers: [tier({ output: "-3" })] }),
    ).toEqual({ ok: false });
    expect(
      parsePriceBookJson({
        ...valid,
        tiers: Array.from({ length: 9 }, (_, index) =>
          tier({ contextOver: 1000 + index }),
        ),
      }),
    ).toEqual({ ok: false });
  });
});
