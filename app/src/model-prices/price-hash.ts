// SPDX-License-Identifier: Apache-2.0

// The hash of a reference price (#549): a confirmation keeps the hash of the price it was made against (models.dev plus
// the override file), and the price counts as changed when today's hash differs. It is also what the portal hands the
// admin with a price and takes back with a confirmation, so that an admin only ever confirms the price they saw.
//
// The hash is versioned, `v<n>:<sha256 hex>`. Version 2 covers every price the book holds (reasoning, audio, the older 200k
// tier, every tier) and the `reasoning` flag of the model, which changes the request. Version 1 was the bare hex digest of
// a book without those; **a confirmation with a hash of another version than the current one counts as stale** (nothing
// was in production when the version changed, so a plain rule is enough): the admin confirms again and the new row carries
// the current version. Whoever changes what the hash covers raises `HASH_VERSION`.
import "server-only";
import { createHash } from "node:crypto";
import { priceBookToJson, type PriceBook } from "./price-book.ts";

export const HASH_VERSION = 2;

export type ReferenceFlags = {
  /** models.dev's `reasoning` flag of the model. */
  reasoning: boolean;
};

/** SHA-256 of the book's JSON form, whose keys are in a fixed order; a model with no price has the hash of `null`. */
export function referenceHash(
  book: PriceBook | null,
  flags: ReferenceFlags,
): string {
  const text = JSON.stringify({
    reasoning: flags.reasoning,
    book: book === null ? null : priceBookToJson(book),
  });
  return `v${String(HASH_VERSION)}:${createHash("sha256").update(text).digest("hex")}`;
}

/** The version a stored hash was made with: 1 for the bare digest of the first release, otherwise the number it names. */
export function hashVersionOf(hash: string): number {
  const match = /^v(\d{1,4}):[0-9a-f]{64}$/.exec(hash);
  return match === null ? 1 : Number(match[1]);
}
