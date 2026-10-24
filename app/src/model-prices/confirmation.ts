// SPDX-License-Identifier: LicenseRef-Proprietary

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

/**
 * The latest row of a model whose price cannot be read back (edited outside the app, or damaged). It is neither "no
 * confirmation" nor the row before it: the model is not priced until an admin confirms it again, which repairs it, and the
 * list shows it with a warning instead of failing as a whole.
 */
export type UnreadableConfirmation = {
  unreadable: true;
  /** The order number of the row. */
  id: number;
  providerId: string;
  modelId: string;
};

/** The confirmation that counts for a model: readable or not. */
export type LatestConfirmation = PriceConfirmation | UnreadableConfirmation;

export function isUnreadable(
  confirmation: LatestConfirmation | undefined | null,
): confirmation is UnreadableConfirmation {
  return confirmation != null && "unreadable" in confirmation;
}
