// SPDX-License-Identifier: Apache-2.0

// Which fields of a price differ between the one an admin confirmed and the one now (#554), so that a stale price says what
// moved. Pure. Client safe.
import type { PriceField } from "../../model-prices/effective-price.ts";
import type {
  PriceBookJson,
  PriceLevelJson,
} from "../../model-prices/price-book.ts";
import { LEVEL_FIELDS } from "./price-form.ts";

function sameLevel(a: PriceLevelJson, b: PriceLevelJson): boolean {
  return LEVEL_FIELDS.every((field) => a[field] === b[field]);
}

function sameLevelOrNone(
  a: PriceLevelJson | null,
  b: PriceLevelJson | null,
): boolean {
  if (a === null || b === null) return a === b;
  return sameLevel(a, b);
}

function sameTiers(a: PriceBookJson["tiers"], b: PriceBookJson["tiers"]) {
  return (
    a.length === b.length &&
    a.every((tier, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        tier.contextOver === other.contextOver &&
        sameLevel(tier, other)
      );
    })
  );
}

/**
 * The fields in which `after` differs from `before`, in the order of the price table: an amount that moved, appeared or is
 * gone, the older price over 200k tokens, the tiers. `after` null (the catalog states no price now) differs in every amount
 * `before` stated.
 */
export function changedPriceFields(
  before: PriceBookJson,
  after: PriceBookJson | null,
): PriceField[] {
  const changed: PriceField[] = LEVEL_FIELDS.filter((field) =>
    after === null ? before[field] !== null : before[field] !== after[field],
  );
  if (!sameLevelOrNone(before.contextOver200k, after?.contextOver200k ?? null))
    changed.push("contextOver200k");
  if (!sameTiers(before.tiers, after?.tiers ?? [])) changed.push("tiers");
  return changed;
}
