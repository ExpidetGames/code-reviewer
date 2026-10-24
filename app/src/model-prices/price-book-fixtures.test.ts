// SPDX-License-Identifier: LicenseRef-Proprietary

// The price books the runner prices usage from (#551) are read from the same JSON as this reader's: one fixture file,
// `fakes/fixtures/price-books.json`, holds books that must parse and books that must be refused, and
// `runner/tests/unit/test_usage_pricing.py` reads the same file with the runner's `parse_price_book`. If the two readers
// ever disagree about what a book is, one of the two tests fails.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePriceBookJson, priceBookToJson } from "./price-book.ts";

type Fixture = {
  valid: { name: string; book: unknown }[];
  invalid: { name: string; book: unknown }[];
};

const fixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "fakes",
      "fixtures",
      "price-books.json",
    ),
    "utf8",
  ),
) as Fixture;

describe("the shared price book fixtures", () => {
  // #551-T08
  it.each(fixture.valid.map((entry) => [entry.name, entry.book] as const))(
    "parses %s",
    (_name, book) => {
      const parsed = parsePriceBookJson(book);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      // The book the app writes out is the book the runner reads: every amount is a digit string.
      const json = priceBookToJson(parsed.book);
      expect(parsePriceBookJson(json)).toEqual(parsed);
    },
  );

  // #551-T08
  it.each(fixture.invalid.map((entry) => [entry.name, entry.book] as const))(
    "refuses %s",
    (_name, book) => {
      expect(parsePriceBookJson(book).ok).toBe(false);
    },
  );
});
