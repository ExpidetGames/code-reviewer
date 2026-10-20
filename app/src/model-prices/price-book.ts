// SPDX-License-Identifier: Apache-2.0

// The price book (#549): every price a managed run is priced from, in BigInt micro-USD per million tokens (`money.ts`),
// built from a models.dev row and the override file, or typed by an admin. A missing price is `null`, never zero: a
// free model is `0n`, an unpriced cache write is not priced at all, and the ledger (#553) fails a call that needs a
// price the book lacks. The JSON form carries every amount as a decimal string, because JSON has no BigInt; it is what
// the database holds and what the portal routes take and answer. Pure. Client safe.
import { z } from "zod";
import type { ModelCost } from "../models-dev/parse.ts";
import { MAX_PRICE_MICRO_USD_PER_MTOK, usdPerMTokToMicroUsd } from "./money.ts";

/** A tier applies to a prompt above `contextOver` tokens (models.dev `tiers`). */
export type PriceTier = {
  contextOver: number;
  input: bigint;
  output: bigint;
  cacheRead: bigint | null;
  /** The price of a cache write with the 5-minute lifetime, which is the one models.dev calls `cache_write`. */
  cacheWrite5m: bigint | null;
  cacheWrite1h: bigint | null;
};

export type PriceBook = Omit<PriceTier, "contextOver"> & {
  tiers: PriceTier[];
};

export type PriceTierJson = {
  contextOver: number;
  input: string;
  output: string;
  cacheRead: string | null;
  cacheWrite5m: string | null;
  cacheWrite1h: string | null;
};
export type PriceBookJson = Omit<PriceTierJson, "contextOver"> & {
  tiers: PriceTierJson[];
};

export const MAX_PRICE_TIERS = 8;
const MAX_CONTEXT_OVER = 100_000_000;

/** The catalog's price of one field to micro-USD; `undefined` when absent (null in the book), null when not exact. */
function catalogAmount(text: string | undefined): bigint | null | undefined {
  if (text === undefined) return undefined;
  return usdPerMTokToMicroUsd(text);
}

/**
 * The reference price of a model: the models.dev price, plus the override's 1-hour cache write (models.dev has none).
 * Null when the catalog states no price, or states one that cannot be held exactly (finer than one micro-USD per million
 * tokens): such a model is `unpriced` until an admin states a price.
 */
export function priceBookFromCatalog(
  cost: ModelCost | null,
  cacheWrite1h: bigint | undefined,
): PriceBook | null {
  if (cost === null) return null;
  const input = catalogAmount(cost.input);
  const output = catalogAmount(cost.output);
  const cacheRead = catalogAmount(cost.cacheRead);
  const cacheWrite5m = catalogAmount(cost.cacheWrite);
  if (input == null || output == null) return null;
  if (cacheRead === null || cacheWrite5m === null) return null;
  const tiers: PriceTier[] = [];
  for (const tier of cost.tiers ?? []) {
    const tierInput = catalogAmount(tier.input);
    const tierOutput = catalogAmount(tier.output);
    const tierCacheRead = catalogAmount(tier.cacheRead);
    const tierCacheWrite = catalogAmount(tier.cacheWrite);
    if (tierInput == null || tierOutput == null) return null;
    if (tierCacheRead === null || tierCacheWrite === null) return null;
    tiers.push({
      contextOver: tier.contextOver,
      input: tierInput,
      output: tierOutput,
      cacheRead: tierCacheRead ?? null,
      cacheWrite5m: tierCacheWrite ?? null,
      cacheWrite1h: null,
    });
  }
  return {
    input,
    output,
    cacheRead: cacheRead ?? null,
    cacheWrite5m: cacheWrite5m ?? null,
    cacheWrite1h: cacheWrite1h ?? null,
    tiers,
  };
}

const text = (value: bigint | null) =>
  value === null ? null : value.toString();

export function priceBookToJson(book: PriceBook): PriceBookJson {
  return {
    input: book.input.toString(),
    output: book.output.toString(),
    cacheRead: text(book.cacheRead),
    cacheWrite5m: text(book.cacheWrite5m),
    cacheWrite1h: text(book.cacheWrite1h),
    tiers: book.tiers.map((tier) => ({
      contextOver: tier.contextOver,
      input: tier.input.toString(),
      output: tier.output.toString(),
      cacheRead: text(tier.cacheRead),
      cacheWrite5m: text(tier.cacheWrite5m),
      cacheWrite1h: text(tier.cacheWrite1h),
    })),
  };
}

/** Whole micro-USD as digits only: no sign, no point, no exponent, within the sanity bound. */
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})$/)
  .transform((value) => BigInt(value))
  .refine((value) => value <= MAX_PRICE_MICRO_USD_PER_MTOK);
const optionalAmount = amount.nullable().default(null);

const tierSchema = z.strictObject({
  contextOver: z.number().int().min(1).max(MAX_CONTEXT_OVER),
  input: amount,
  output: amount,
  cacheRead: optionalAmount,
  cacheWrite5m: optionalAmount,
  cacheWrite1h: optionalAmount,
});

const bookSchema = z
  .strictObject({
    input: amount,
    output: amount,
    cacheRead: optionalAmount,
    cacheWrite5m: optionalAmount,
    cacheWrite1h: optionalAmount,
    tiers: z.array(tierSchema).max(MAX_PRICE_TIERS).default([]),
  })
  .refine((book) =>
    book.tiers.every(
      (tier, index) =>
        index === 0 ||
        tier.contextOver > (book.tiers[index - 1]?.contextOver ?? 0),
    ),
  );

export type PriceBookParse = { ok: true; book: PriceBook } | { ok: false };

/** Reads a book from JSON (an admin's input, or what the database holds); anything that is not exactly a book is refused. */
export function parsePriceBookJson(input: unknown): PriceBookParse {
  const parsed = bookSchema.safeParse(input);
  return parsed.success ? { ok: true, book: parsed.data } : { ok: false };
}
