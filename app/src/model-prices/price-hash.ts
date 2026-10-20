// SPDX-License-Identifier: Apache-2.0

// The hash of a reference price (#549): a confirmation keeps the hash of the price it was made against (models.dev plus
// the override file), and the price counts as changed when today's hash differs. It is also what the portal hands the
// admin with a price and takes back with a confirmation, so that an admin only ever confirms the price they saw.
import "server-only";
import { createHash } from "node:crypto";
import { priceBookToJson, type PriceBook } from "./price-book.ts";

/** SHA-256 of the book's JSON form, whose keys are in a fixed order; a model with no price has the hash of `null`. */
export function referenceHash(book: PriceBook | null): string {
  const text = JSON.stringify(book === null ? null : priceBookToJson(book));
  return createHash("sha256").update(text).digest("hex");
}
