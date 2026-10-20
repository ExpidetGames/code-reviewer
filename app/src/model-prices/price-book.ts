// SPDX-License-Identifier: Apache-2.0

// The price book (#549): every price a managed run is priced from, in BigInt micro-USD per million tokens (`money.ts`),
// built from a models.dev row and the override file, or typed by an admin. A missing price is `null`, never zero: a
// free model is `0n`, an unpriced cache write is not priced at all, and the ledger (#553) fails a call that needs a
// price the book lacks. The JSON form carries every amount as a decimal string, because JSON has no BigInt; it is what
// the database holds and what the portal routes take and answer. Pure. Client safe.
import { z } from "zod";
import {
  MAX_COST_TIERS,
  type CostAmounts,
  type ModelCost,
} from "../models-dev/parse.ts";
import { MAX_PRICE_MICRO_USD_PER_MTOK, usdPerMTokToMicroUsd } from "./money.ts";

/**
 * Every price one level states, as models.dev names them: the base price, a tier and the older `context_over_200k`. A cache
 * write with the 5-minute lifetime is the one models.dev calls `cache_write`; models.dev has no 1-hour price, so that comes
 * from the override file (or an admin) and is null in a tier. `reasoning` is the price of reasoning tokens when it differs
 * from the output price, the audio prices those of audio tokens; null is "not priced", never zero.
 */
export type PriceLevel = {
  input: bigint;
  output: bigint;
  cacheRead: bigint | null;
  cacheWrite5m: bigint | null;
  cacheWrite1h: bigint | null;
  reasoning: bigint | null;
  inputAudio: bigint | null;
  outputAudio: bigint | null;
};

/** A tier applies to a prompt above `contextOver` tokens (models.dev `tiers`). */
export type PriceTier = PriceLevel & { contextOver: number };

export type PriceBook = PriceLevel & {
  /** models.dev's older spelling of a tier above 200,000 tokens, kept as stated; null when it states none. */
  contextOver200k: PriceLevel | null;
  /** From the smallest context up. */
  tiers: PriceTier[];
};

type Texts<T> = {
  [K in keyof T]: T[K] extends bigint
    ? string
    : T[K] extends bigint | null
      ? string | null
      : T[K];
};
export type PriceLevelJson = Texts<PriceLevel>;
export type PriceTierJson = PriceLevelJson & { contextOver: number };
export type PriceBookJson = PriceLevelJson & {
  contextOver200k: PriceLevelJson | null;
  tiers: PriceTierJson[];
};

/** As many tiers as `parse.ts` stores; a catalog row with more is flagged and unpriced there. */
export const MAX_PRICE_TIERS = MAX_COST_TIERS;
const MAX_CONTEXT_OVER = 100_000_000;

/** One level of the catalog's price in micro-USD; null when an amount cannot be held exactly (finer than a micro-USD). */
function levelFromCatalog(
  amounts: CostAmounts,
  cacheWrite1h: bigint | null,
): PriceLevel | null {
  const input = usdPerMTokToMicroUsd(amounts.input);
  const output = usdPerMTokToMicroUsd(amounts.output);
  if (input === null || output === null) return null;
  const optional = [
    amounts.cacheRead,
    amounts.cacheWrite,
    amounts.reasoning,
    amounts.inputAudio,
    amounts.outputAudio,
  ].map((text) =>
    text === undefined ? undefined : usdPerMTokToMicroUsd(text),
  );
  if (optional.includes(null)) return null;
  const [cacheRead, cacheWrite5m, reasoning, inputAudio, outputAudio] =
    optional.map((value) => value ?? null);
  return {
    input,
    output,
    cacheRead: cacheRead ?? null,
    cacheWrite5m: cacheWrite5m ?? null,
    cacheWrite1h,
    reasoning: reasoning ?? null,
    inputAudio: inputAudio ?? null,
    outputAudio: outputAudio ?? null,
  };
}

/**
 * The reference price of a model: the models.dev price, plus the override's 1-hour cache write (models.dev has none).
 * Null when the catalog states no price, states one that cannot be held exactly (finer than one micro-USD per million
 * tokens), or states something about the price we do not understand (`cost.unknown`: a price field or a tier of a kind we do
 * not know, which may be the price that applies): such a model is `unpriced` until an admin states a price.
 */
export function priceBookFromCatalog(
  cost: ModelCost | null,
  cacheWrite1h: bigint | undefined,
): PriceBook | null {
  if (cost === null) return null;
  if (cost.unknown !== undefined && cost.unknown.length > 0) return null;
  const base = levelFromCatalog(cost, cacheWrite1h ?? null);
  if (base === null) return null;
  let contextOver200k: PriceLevel | null = null;
  if (cost.contextOver200k !== undefined) {
    contextOver200k = levelFromCatalog(cost.contextOver200k, null);
    if (contextOver200k === null) return null;
  }
  const tiers: PriceTier[] = [];
  for (const tier of cost.tiers ?? []) {
    const level = levelFromCatalog(tier, null);
    if (level === null) return null;
    tiers.push({ contextOver: tier.contextOver, ...level });
  }
  // models.dev does not promise an order, a book states tiers from the smallest context up, and two tiers of one size are
  // not one price: that catalog row is unpriced until an admin states the price.
  tiers.sort((a, b) => a.contextOver - b.contextOver);
  if (
    tiers.some(
      (tier, i) => i > 0 && tier.contextOver === tiers[i - 1]?.contextOver,
    )
  )
    return null;
  return { ...base, contextOver200k, tiers };
}

const text = (value: bigint | null) =>
  value === null ? null : value.toString();

function levelToJson(level: PriceLevel): PriceLevelJson {
  return {
    input: level.input.toString(),
    output: level.output.toString(),
    cacheRead: text(level.cacheRead),
    cacheWrite5m: text(level.cacheWrite5m),
    cacheWrite1h: text(level.cacheWrite1h),
    reasoning: text(level.reasoning),
    inputAudio: text(level.inputAudio),
    outputAudio: text(level.outputAudio),
  };
}

/** The keys are always in this order, which the hash of a reference price relies on. */
export function priceBookToJson(book: PriceBook): PriceBookJson {
  return {
    ...levelToJson(book),
    contextOver200k:
      book.contextOver200k === null ? null : levelToJson(book.contextOver200k),
    tiers: book.tiers.map((tier) => ({
      contextOver: tier.contextOver,
      ...levelToJson(tier),
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

const levelShape = {
  input: amount,
  output: amount,
  cacheRead: optionalAmount,
  cacheWrite5m: optionalAmount,
  cacheWrite1h: optionalAmount,
  reasoning: optionalAmount,
  inputAudio: optionalAmount,
  outputAudio: optionalAmount,
};

const tierSchema = z.strictObject({
  contextOver: z.number().int().min(1).max(MAX_CONTEXT_OVER),
  ...levelShape,
});

const bookSchema = z
  .strictObject({
    ...levelShape,
    contextOver200k: z.strictObject(levelShape).nullable().default(null),
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
