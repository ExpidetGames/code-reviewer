// SPDX-License-Identifier: LicenseRef-Proprietary

// The effective price of a model (#549, part C): a pure function of the models.dev row, the override file and the admin's
// latest confirmation. What is priced from is **a whole book**: the admin's confirmed book (a correction replaces the whole
// book, it is not merged field by field), and the reference an admin is asked to confirm is models.dev's price with the
// override file's 1-hour cache write over it. `sources` says per field where each amount of the shown book comes from
// (catalog, override, admin), for the admin to read; it decides nothing. The status decides whether the managed key, which we
// pay, may use the model:
//   confirmed    an admin confirmed (or corrected) the price and neither models.dev nor the override has moved since;
//   stale        they have moved since, or the hash is of another version: the safe default is to treat it as unconfirmed
//                until the admin confirms again;
//   unconfirmed  there is a price, and nobody has confirmed it;
//   unpriced     models.dev states none (or one we cannot read) and nobody has stated one.
// Only a `confirmed` price has a `book`, so nothing that prices a run can read one by mistake; every other status has
// `book: null` and shows a price to look at in `display`. A price is confirmed against the *reference* (models.dev plus the
// override file) as it was then, by hash (`price-hash.ts`), so a change of any price, a tier or the model's `reasoning` flag is
// seen, and a change back is not stale.
import "server-only";
import type { ModelCost } from "../models-dev/parse.ts";
import type { PriceConfirmation } from "./confirmation.ts";
import type { ModelOverride } from "./overrides.ts";
import {
  priceBookFromCatalog,
  priceBookToJson,
  type PriceBook,
} from "./price-book.ts";
import { HASH_VERSION, hashVersionOf, referenceHash } from "./price-hash.ts";

export const PRICE_STATUSES = [
  "confirmed",
  "stale",
  "unconfirmed",
  "unpriced",
] as const;
export type PriceStatus = (typeof PRICE_STATUSES)[number];

export const PRICE_SOURCES = ["catalog", "override", "admin"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const PRICE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite5m",
  "cacheWrite1h",
  "reasoning",
  "inputAudio",
  "outputAudio",
  "contextOver200k",
  "tiers",
] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];
/** Where each field of a book comes from; null for a field the book does not price. */
export type PriceSources = Record<PriceField, PriceSource | null>;

type EffectivePriceShared = {
  sources: PriceSources | null;
  /** The price today, from models.dev and the override file, and its hash. */
  reference: {
    book: PriceBook | null;
    hash: string;
    sources: PriceSources | null;
  };
  /** The latest confirmation, whatever the status. */
  confirmation: PriceConfirmation | null;
};

export type EffectivePrice = EffectivePriceShared &
  (
    | {
        status: "confirmed";
        /** The book the managed key prices from: the confirmed one. */
        book: PriceBook;
        /** The same book, for the admin's view. */
        display: PriceBook;
      }
    | {
        status: Exclude<PriceStatus, "confirmed">;
        /** Not a price to run on. */
        book: null;
        /**
         * What the admin is shown: the old confirmed price of a stale one, the reference they would confirm for an unconfirmed
         * one, null when unpriced.
         */
        display: PriceBook | null;
      }
  );

export type EffectivePriceInput = {
  cost: ModelCost | null;
  /** models.dev's `reasoning` flag of the model: part of the reference, because it changes the request. */
  reasoning: boolean;
  override: ModelOverride | undefined;
  confirmation: PriceConfirmation | null;
};

function sourcesOfReference(
  book: PriceBook | null,
  override: ModelOverride | undefined,
): PriceSources | null {
  if (book === null) return null;
  return {
    input: "catalog",
    output: "catalog",
    cacheRead: book.cacheRead === null ? null : "catalog",
    cacheWrite5m: book.cacheWrite5m === null ? null : "catalog",
    cacheWrite1h:
      book.cacheWrite1h === null
        ? null
        : override?.cacheWrite1h == null
          ? "catalog"
          : "override",
    reasoning: book.reasoning === null ? null : "catalog",
    inputAudio: book.inputAudio === null ? null : "catalog",
    outputAudio: book.outputAudio === null ? null : "catalog",
    contextOver200k: book.contextOver200k === null ? null : "catalog",
    tiers: book.tiers.length === 0 ? null : "catalog",
  };
}

const tiersText = (book: PriceBook | null) =>
  book === null ? null : JSON.stringify(priceBookToJson(book).tiers);
const olderTierText = (book: PriceBook | null) =>
  book === null ? null : JSON.stringify(priceBookToJson(book).contextOver200k);

/** The sources of a confirmed book: the reference's, except for the fields an admin's correction changed or added. */
function sourcesOfConfirmed(
  confirmation: PriceConfirmation,
  reference: PriceSources | null,
): PriceSources {
  const { book, reference: was } = confirmation;
  const corrected = confirmation.source === "admin";
  const sourceOf = (
    field: PriceField,
    priced: boolean,
    changed: boolean,
  ): PriceSource | null => {
    if (!priced) return null;
    return corrected && changed ? "admin" : (reference?.[field] ?? "catalog");
  };
  return {
    input: sourceOf("input", true, was === null || book.input !== was.input),
    output: sourceOf(
      "output",
      true,
      was === null || book.output !== was.output,
    ),
    cacheRead: sourceOf(
      "cacheRead",
      book.cacheRead !== null,
      was?.cacheRead !== book.cacheRead,
    ),
    cacheWrite5m: sourceOf(
      "cacheWrite5m",
      book.cacheWrite5m !== null,
      was?.cacheWrite5m !== book.cacheWrite5m,
    ),
    cacheWrite1h: sourceOf(
      "cacheWrite1h",
      book.cacheWrite1h !== null,
      was?.cacheWrite1h !== book.cacheWrite1h,
    ),
    reasoning: sourceOf(
      "reasoning",
      book.reasoning !== null,
      was?.reasoning !== book.reasoning,
    ),
    inputAudio: sourceOf(
      "inputAudio",
      book.inputAudio !== null,
      was?.inputAudio !== book.inputAudio,
    ),
    outputAudio: sourceOf(
      "outputAudio",
      book.outputAudio !== null,
      was?.outputAudio !== book.outputAudio,
    ),
    contextOver200k: sourceOf(
      "contextOver200k",
      book.contextOver200k !== null,
      olderTierText(was) !== olderTierText(book),
    ),
    tiers: sourceOf(
      "tiers",
      book.tiers.length > 0,
      tiersText(was) !== tiersText(book),
    ),
  };
}

export function effectivePrice(input: EffectivePriceInput): EffectivePrice {
  const { cost, override, confirmation } = input;
  const referenceBook = priceBookFromCatalog(
    cost,
    override?.cacheWrite1h ?? undefined,
  );
  const referenceSources = sourcesOfReference(referenceBook, override);
  const reference = {
    book: referenceBook,
    hash: referenceHash(referenceBook, { reasoning: input.reasoning }),
    sources: referenceSources,
  };
  if (confirmation === null)
    return {
      status: referenceBook === null ? "unpriced" : "unconfirmed",
      book: null,
      display: referenceBook,
      sources: referenceSources,
      reference,
      confirmation: null,
    };
  // A hash of another version cannot be compared with today's, so it is stale whatever it looks like (price-hash.ts).
  const current =
    hashVersionOf(confirmation.referenceHash) === HASH_VERSION &&
    confirmation.referenceHash === reference.hash;
  const sources = sourcesOfConfirmed(confirmation, referenceSources);
  if (current)
    return {
      status: "confirmed",
      book: confirmation.book,
      display: confirmation.book,
      sources,
      reference,
      confirmation,
    };
  return {
    status: "stale",
    book: null,
    display: confirmation.book,
    sources,
    reference,
    confirmation,
  };
}
