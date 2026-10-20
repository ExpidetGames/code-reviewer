// SPDX-License-Identifier: Apache-2.0

// What an admin's confirmation of a price is (#549, part B): one row of the append-only history, the latest of which
// counts. Types only.
import type { PriceBook } from "./price-book.ts";

export const CONFIRMATION_SOURCES = [
  /** The admin confirmed the price as it was shown. */
  "catalog",
  /** The admin corrected the price; `reason` says why. */
  "admin",
] as const;
export type ConfirmationSource = (typeof CONFIRMATION_SOURCES)[number];

export type PriceConfirmation = {
  /** The order the rows were written in; the highest of a model is the one that counts. */
  id: number;
  providerId: string;
  modelId: string;
  source: ConfirmationSource;
  /** The price the managed key prices from: the reference as shown, or the admin's correction of it. */
  book: PriceBook;
  /** The reference price (models.dev plus the override file) when the admin confirmed; null when the catalog had none. */
  reference: PriceBook | null;
  /** Hash of `reference` (`price-hash.ts`): the price changed after the confirmation when it no longer matches. */
  referenceHash: string;
  /** Why the admin corrected the price; null for a confirmation as shown. */
  reason: string | null;
  /** The user who confirmed, or null when the user is gone. */
  confirmedBy: string | null;
  confirmedAt: string;
};
